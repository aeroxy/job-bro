import { runWithValidation, validateNumbers } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import type { PreferenceResult } from '@/types/evaluation'
import type { LLMConfig } from '@/types/profile'

const SYSTEM_PROMPT = `You are a career advisor comparing job preferences vs job posting.
Check remote/onsite, location, company size, industry, deal breakers.
Output compact JSON only, no whitespace outside strings:
{"alignment_score":0.0,"conflicts":[{"category":"","expected":"","actual":"","severity":"low"}],"matches":[],"summary":""}`

export async function runPreferenceEvaluator(
  sharedPrefix: ChatMessage[],
  config: LLMConfig,
  signal?: AbortSignal
): Promise<PreferenceResult> {
  const messages: ChatMessage[] = [
    ...sharedPrefix,
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Analyze the job posting.' },
  ]
  return runWithValidation<PreferenceResult>(
    config,
    messages,
    (r) =>
      validateNumbers(r, ['alignment_score']) ??
      (Array.isArray(r.conflicts) && Array.isArray(r.matches)
        ? null
        : '"conflicts" and "matches" must be arrays'),
    signal
  )
}
