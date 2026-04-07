import { runWithValidation, validateNumbers } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import type { GrowthResult } from '@/types/evaluation'
import type { LLMConfig } from '@/types/profile'

const SYSTEM_PROMPT = `You are a career strategist evaluating growth potential of a role.
Assess: learning opportunity (new skills/tech), company brand value for resume, career trajectory.
Output compact JSON only, no whitespace outside strings:
{"learning_opportunity":0.0,"brand_value":0.0,"career_trajectory":0.0,"overall_growth":0.0,"highlights":[],"concerns":[],"summary":""}`

export async function runGrowthEvaluator(
  sharedPrefix: ChatMessage[],
  config: LLMConfig,
  signal?: AbortSignal
): Promise<GrowthResult> {
  const messages: ChatMessage[] = [
    ...sharedPrefix,
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Analyze the job posting.' },
  ]
  return runWithValidation<GrowthResult>(
    config,
    messages,
    (r) =>
      validateNumbers(r, [
        'learning_opportunity', 'brand_value', 'career_trajectory', 'overall_growth',
      ]) ??
      (Array.isArray(r.highlights) && Array.isArray(r.concerns)
        ? null
        : '"highlights" and "concerns" must be arrays'),
    signal
  )
}
