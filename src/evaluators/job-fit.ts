import { runWithValidation, validateNumbers, buildResumeContext } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import type { JobFitResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'

const PROMPT = `You are a technical recruiter evaluating job fit.
Compare candidate skills/experience vs job requirements.
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
