import type { ChatMessage, JsonSchemaSpec } from '@/lib/llm-client'
import { buildPriorResearchContext } from '@/lib/llm-client'
import { runAgentWithValidation, executeTool } from '@/lib/agent'
import type { ToolDefinition } from '@/lib/tools/types'
import type { EvidenceItem, JobFitResult, RiskResult, SalaryResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'
import type { ToolCall } from '@/lib/tools/types'
import type { ToolExecutor } from '@/lib/agent'
import { RISK_SCHEMA } from './schemas'

export const RISK_SCHEMA_NAME = 'risk_result'
export const RISK_JSON_SCHEMA: JsonSchemaSpec = {
  name: RISK_SCHEMA_NAME,
  schema: RISK_SCHEMA as unknown as Record<string, unknown>,
}

// Upstream conclusions piped in from the job-fit and salary evaluators, which
// run first in the staged pipeline. Risk consumes them instead of re-deriving
// domain fit and compensation from scratch — keeps the flags consistent with
// what those evaluators concluded and cuts duplicate reasoning / tool calls.
export interface RiskUpstream {
  jobFit?: JobFitResult
  salary?: SalaryResult
}

function buildRiskUpstreamContext(upstream?: RiskUpstream): string | null {
  if (!upstream) return null
  const parts: string[] = []
  if (upstream.jobFit) {
    const jf = upstream.jobFit
    parts.push(`<job_fit_analysis>
overall_fit: ${jf.overall_fit}
skill_match: ${jf.skill_match}
experience_match: ${jf.experience_match}
matching_skills: ${jf.matching_skills.join(', ') || 'none'}
gaps: ${jf.gaps.join('; ') || 'none'}
summary: ${jf.summary}
</job_fit_analysis>`)
  }
  if (upstream.salary) {
    const s = upstream.salary
    parts.push(`<salary_analysis>
estimated_range: ${s.estimated_range.min}-${s.estimated_range.max} ${s.estimated_range.currency}
expectation_alignment: ${s.expectation_alignment}
risk_flag: ${s.risk_flag}
reasoning: ${s.reasoning}
</salary_analysis>`)
  }
  if (!parts.length) return null
  return `A job-fit analysis and/or salary analysis have already been completed for this candidate and job. Treat their conclusions as authoritative — do NOT re-derive domain fit or compensation from scratch. Use the job-fit gaps to inform under_leveling / overqualification / unrealistic_requirements / domain_pivot_required, and the salary analysis to inform seed_stage_comp_risk / founding_role_undisclosed_comp. Build your risk flags on top of these.

${parts.join('\n')}`
}

const PROMPT = `You are a job posting risk analyst. Identify red flags across these categories (use the "type" field):
- under_leveling, overqualification
- vague_jd, toxic_signals, high_turnover
- unrealistic_requirements — identify these by scanning the skill list in the description and comparing it against the stated experience level
- stealth_no_diligence — stealth-mode company with insufficient public info to evaluate technology, team, or financial health
- seed_stage_comp_risk — seed/pre-seed stage where cash compensation is likely well below candidate's expectation and equity is illiquid
- founding_role_undisclosed_comp — founding-team title (CTO, founding engineer, etc.) without disclosed cash compensation
- domain_pivot_required — role's primary technical domain (e.g., hardware, embedded, sensors) has no overlap with candidate's demonstrated background

Calibration for senior/executive roles (CTO, VP, Director, Principal):
- Seed or stealth stage WITHOUT disclosed compensation is at MINIMUM "medium" risk — cash floor is unpredictable and equity is illiquid.
- If the candidate's stated salary expectation is high (>$300k USD-equivalent base) and the role is a founding/seed role with equity-heavy comp, escalate to "high" risk on seed_stage_comp_risk.
- Stealth + founding + no public team/funding info → flag stealth_no_diligence at medium or high.

For more junior IC roles, do not over-penalize normal startup ambiguity.

You have access to two tools: \`web_search\` (for finding public information about a company, role, or market) and \`read_page\` (for reading a specific URL). Use them when the JD lacks information you would need to assess risk — e.g., a company name you'd otherwise have to guess at, or an unfamiliar role. Do not call tools for facts already present in the JD.

Evidences: list the sources you actually relied on in an "evidences" array of {"title":"","url":"","snippet":""}. Each entry must be a page you read (or a search result you clicked through and read); do not include searches you didn't act on. If you didn't use any tools, emit "evidences": [].`

export async function runRiskEvaluator(
  jobContent: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt: string,
  tools: ToolDefinition[],
  onToolCall?: (call: ToolCall) => void,
  signal?: AbortSignal,
  jsonSchema?: JsonSchemaSpec,
  upstream?: RiskUpstream,
  priorResearch?: EvidenceItem[],
  exec: ToolExecutor = executeTool,
  verdictName?: string
): Promise<RiskResult> {
  const messages: ChatMessage[] = []
  if (customPrompt) messages.push({ role: 'system', content: customPrompt })
  // Include years_of_experience and salary_expectation for leveling and comp-risk detection
  const yearsOfExp = profile.preferences.years_of_experience
  const salaryExp = profile.salary_expectation?.trim()
  if (yearsOfExp > 0 || salaryExp) {
    const parts: string[] = []
    if (yearsOfExp > 0) parts.push(`<years_of_experience>${yearsOfExp}</years_of_experience>`)
    if (salaryExp) parts.push(`<salary_expectation>${salaryExp}</salary_expectation>`)
    messages.push({ role: 'system', content: `<candidate_experience>\n${parts.join('\n')}\n</candidate_experience>` })
  }
  // Upstream conclusions and prior web research derive from untrusted content
  // (the JD and fetched pages), so they go in as 'user' — never 'system' —
  // to avoid elevating attacker-controllable text to instruction priority.
  const upstreamContext = buildRiskUpstreamContext(upstream)
  if (upstreamContext) messages.push({ role: 'user', content: upstreamContext })
  if (priorResearch) {
    const research = buildPriorResearchContext(priorResearch)
    if (research) messages.push({ role: 'user', content: research })
  }
  messages.push({ role: 'system', content: `Output compact JSON only, no whitespace outside strings:
{"overall_risk":"low","flags":[{"type":"other","description":"","severity":"low"}],"summary":"","evidences":[]}` })
  messages.push({ role: 'user', content: `<jd>\n${jobContent}\n</jd>` })
  messages.push({ role: 'user', content: PROMPT })

  return runAgentWithValidation<RiskResult>(
    config,
    messages,
    {
      tools,
      executeTool: exec,
      validate: (r) => {
        if (!['low', 'medium', 'high'].includes(r.overall_risk as string))
          return '"overall_risk" must be "low", "medium", or "high"'
        if (!Array.isArray(r.flags)) return '"flags" must be an array'
        if (typeof r.summary !== 'string' || !r.summary.trim()) return '"summary" must be a non-empty string'
        if (r.evidences !== undefined && !Array.isArray(r.evidences)) return '"evidences" must be an array'
        return null
      },
      signal,
      onToolCall,
      jsonSchema,
      verdictName,
    }
  )
}
