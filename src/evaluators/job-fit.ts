import { runWithValidation, validateNumbers, buildResumeContext } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import type { JobFitResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'

const PROMPT = `You are a technical recruiter evaluating job fit.

Process:
1. First, identify the job's PRIMARY TECHNICAL DOMAIN from the JD (e.g., hardware/sensors, embedded/firmware, fintech infra, ML platform, web infra, devops, mobile, data engineering, security). State it implicitly via your scoring.
2. Identify the candidate's DEMONSTRATED domains from their resume — what they have actually shipped, not just titles held.
3. Score the alignment between (1) and (2).

Critical scoring rules:
- Leadership, architecture, scaling, and "founder" experience are TRANSFERABLE traits but DO NOT substitute for domain expertise. A backend/AI leader is not a hardware leader. A web-infra architect is not an embedded systems architect.
- If the JD's primary domain has NO concrete representation in the candidate's resume (no shipped projects, no equivalent technical depth, no adjacent domain experience), cap "skill_match" AND "overall_fit" at 0.5 maximum, regardless of how strong the leadership or general engineering signals are.
- "matching_skills" must be ACTUAL technical overlaps, not generic traits like "leadership" or "communication".
- "gaps" MUST explicitly enumerate any domain-level gaps (e.g., "No hardware/sensor engineering experience", "No embedded firmware background"). Surface these even when other signals are strong.

Focus strictly on skills, experience, and role scope. Do not comment on salary, compensation, or location — those are evaluated separately.`

export async function runJobFitEvaluator(
  jobContent: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt?: string,
  signal?: AbortSignal
): Promise<JobFitResult> {
  const messages: ChatMessage[] = []
  if (customPrompt?.trim()) messages.push({ role: 'system', content: customPrompt.trim() })
  messages.push({ role: 'system', content: buildResumeContext(profile) })
  messages.push({ role: 'system', content: `Output compact JSON only, no whitespace outside strings:
{"skill_match":0.0,"experience_match":0.0,"overall_fit":0.0,"matching_skills":[],"gaps":[],"strengths":[],"summary":""}` })
  messages.push({ role: 'user', content: `<jd>\n${jobContent}\n</jd>` })
  messages.push({ role: 'user', content: PROMPT })

  return runWithValidation<JobFitResult>(
    config,
    messages,
    (r) =>
      validateNumbers(r, ['skill_match', 'experience_match', 'overall_fit']) ??
      (Array.isArray(r.gaps) && Array.isArray(r.strengths) && Array.isArray(r.matching_skills)
        ? null
        : '"gaps", "strengths", "matching_skills" must be arrays'),
    signal
  )
}
