import { runWithValidation } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import type { RiskResult } from '@/types/evaluation'
import type { LLMConfig } from '@/types/profile'

const SYSTEM_PROMPT = `You are a job posting risk analyst. Identify red flags: under-leveling, overqualification, vague JD, toxic signals, unrealistic requirements, high turnover.
Be calibrated — not every startup is a red flag.
Output compact JSON only, no whitespace outside strings:
{"overall_risk":"low","flags":[{"type":"other","description":"","severity":"low"}],"summary":""}`

export async function runRiskEvaluator(
  sharedPrefix: ChatMessage[],
  config: LLMConfig,
  signal?: AbortSignal
): Promise<RiskResult> {
  const messages: ChatMessage[] = [
    ...sharedPrefix,
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Analyze the job posting.' },
  ]
  return runWithValidation<RiskResult>(
    config,
    messages,
    (r) => {
      if (!['low', 'medium', 'high'].includes(r.overall_risk as string))
        return '"overall_risk" must be "low", "medium", or "high"'
      if (!Array.isArray(r.flags)) return '"flags" must be an array'
      return null
    },
    signal
  )
}
