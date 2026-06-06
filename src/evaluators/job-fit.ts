import { validateNumbers, buildResumeContext } from '@/lib/llm-client'
import type { ChatMessage, JsonSchemaSpec } from '@/lib/llm-client'
import { runAgentWithValidation, executeTool } from '@/lib/agent'
import type { ToolDefinition } from '@/lib/tools/types'
import type { JobFitResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'
import type { ToolCall } from '@/lib/tools/types'
import type { ToolExecutor } from '@/lib/agent'
import { JOB_FIT_SCHEMA } from './schemas'

export const JOB_FIT_SCHEMA_NAME = 'job_fit_result'
export const JOB_FIT_JSON_SCHEMA: JsonSchemaSpec = {
  name: JOB_FIT_SCHEMA_NAME,
  schema: JOB_FIT_SCHEMA as unknown as Record<string, unknown>,
}

const PROMPT = `You are a technical recruiter evaluating job fit.

Process:
1. First, identify the job's PRIMARY TECHNICAL DOMAIN from the JD (e.g., hardware/sensors, embedded/firmware, fintech infra, ML platform, web infra, devops, mobile, data engineering, security). State it implicitly via your scoring.
2. Carefully scan the 'Description' for the stated experience level (e.g., Senior, Staff, Lead) and specific technical requirements/qualifications.
3. Identify the candidate's DEMONSTRATED domains from their resume — what they have actually shipped, not just titles held.
4. Score the alignment between (1, 2) and (3).

Critical scoring rules:
- Leadership, architecture, scaling, and "founder" experience are TRANSFERABLE traits but DO NOT substitute for domain expertise. A backend/AI leader is not a hardware leader. A web-infra architect is not an embedded systems architect.
- If the JD's primary domain has NO concrete representation in the candidate's resume (no shipped projects, no equivalent technical depth, no adjacent domain experience), cap "skill_match" AND "overall_fit" at 0.5 maximum, regardless of how strong the leadership or general engineering signals are.
- "matching_skills" must be ACTUAL technical overlaps, not generic traits like "leadership" or "communication".
- "gaps" MUST explicitly enumerate any domain-level gaps (e.g., "No hardware/sensor engineering experience", "No embedded firmware background"). Surface these even when other signals are strong.

Focus strictly on skills, experience, and role scope. Do not comment on salary, compensation, or location — those are evaluated separately.

Base your assessment on the provided JD and resume — no external lookups. Emit "evidences": [].`

export async function runJobFitEvaluator(
  jobContent: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt: string,
  tools: ToolDefinition[],
  onToolCall?: (call: ToolCall) => void,
  signal?: AbortSignal,
  jsonSchema?: JsonSchemaSpec,
  exec: ToolExecutor = executeTool
): Promise<JobFitResult> {
  const messages: ChatMessage[] = []
  if (customPrompt) messages.push({ role: 'system', content: customPrompt })
  messages.push({ role: 'system', content: buildResumeContext(profile) })
  messages.push({ role: 'system', content: `Output compact JSON only, no whitespace outside strings:
{"skill_match":0.0,"experience_match":0.0,"overall_fit":0.0,"matching_skills":[],"gaps":[],"strengths":[],"summary":"","evidences":[]}` })
  messages.push({ role: 'user', content: `<jd>\n${jobContent}\n</jd>` })
  messages.push({ role: 'user', content: PROMPT })

  return runAgentWithValidation<JobFitResult>(
    config,
    messages,
    {
      tools,
      executeTool: exec,
      validate: (r) => {
        const base = validateNumbers(r, ['skill_match', 'experience_match', 'overall_fit']) ??
          (Array.isArray(r.gaps) && Array.isArray(r.strengths) && Array.isArray(r.matching_skills)
            ? null
            : '"gaps", "strengths", "matching_skills" must be arrays')
        if (base) return base
        if (typeof r.summary !== 'string' || !r.summary.trim()) return '"summary" must be a non-empty string'
        if (r.evidences !== undefined && !Array.isArray(r.evidences)) return '"evidences" must be an array'
        return null
      },
      signal,
      onToolCall,
      jsonSchema,
    }
  )
}
