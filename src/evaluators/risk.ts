import type { ChatMessage } from '@/lib/llm-client'
import { runAgentWithValidation, executeTool } from '@/lib/agent'
import { ALL_TOOLS } from '@/lib/tools/definitions'
import type { RiskResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'

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

You have access to two tools: \`google_search\` (for finding public information about a company, role, or market) and \`read_page\` (for reading a specific URL). Use them when the JD lacks information you would need to assess risk — e.g., a company name you'd otherwise have to guess at, or an unfamiliar role. Do not call tools for facts already present in the JD. When you are done, output the compact JSON described above.`

export async function runRiskEvaluator(
  jobContent: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt: string,
  signal?: AbortSignal
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
  messages.push({ role: 'system', content: `Output compact JSON only, no whitespace outside strings:
{"overall_risk":"low","flags":[{"type":"other","description":"","severity":"low"}],"summary":""}` })
  messages.push({ role: 'user', content: `<jd>\n${jobContent}\n</jd>` })
  messages.push({ role: 'user', content: PROMPT })

  return runAgentWithValidation<RiskResult>(
    config,
    messages,
    {
      tools: ALL_TOOLS,
      executeTool,
      validate: (r) => {
        if (!['low', 'medium', 'high'].includes(r.overall_risk as string))
          return '"overall_risk" must be "low", "medium", or "high"'
        if (!Array.isArray(r.flags)) return '"flags" must be an array'
        return null
      },
      signal,
    }
  )
}
