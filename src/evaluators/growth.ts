import { runWithValidation, validateNumbers, buildResumeContext } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import type { GrowthResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'

const PROMPT = `You are a career strategist evaluating growth potential of a role.
Assess: learning opportunity (new skills/tech), company brand value for resume, career trajectory.`

export async function runGrowthEvaluator(
  jobContent: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt?: string,
  signal?: AbortSignal
): Promise<GrowthResult> {
  const messages: ChatMessage[] = []
  if (customPrompt?.trim()) messages.push({ role: 'system', content: customPrompt.trim() })
  messages.push({ role: 'system', content: buildResumeContext(profile) })
  messages.push({ role: 'system', content: `Output compact JSON only, no whitespace outside strings:
{"learning_opportunity":0.0,"brand_value":0.0,"career_trajectory":0.0,"overall_growth":0.0,"highlights":[],"concerns":[],"summary":""}` })
  messages.push({ role: 'user', content: `<jd>\n${jobContent}\n</jd>` })
  messages.push({ role: 'user', content: PROMPT })

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
