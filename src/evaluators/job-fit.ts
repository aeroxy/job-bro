import { runWithValidation, validateNumbers } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import type { JobFitResult } from '@/types/evaluation'
import type { LLMConfig } from '@/types/profile'

const SYSTEM_PROMPT = `You are a technical recruiter evaluating job fit.
Compare candidate skills/experience vs job requirements.
Output compact JSON only, no whitespace outside strings:
{"skill_match":0.0,"experience_match":0.0,"overall_fit":0.0,"matching_skills":[],"gaps":[],"strengths":[],"summary":""}`

export async function runJobFitEvaluator(
  sharedPrefix: ChatMessage[],
  config: LLMConfig,
  signal?: AbortSignal
): Promise<JobFitResult> {
  const messages: ChatMessage[] = [
    ...sharedPrefix,
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Analyze the job posting.' },
  ]
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
