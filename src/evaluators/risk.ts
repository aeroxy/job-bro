import { runWithValidation } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import type { RiskResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'

const PROMPT = `You are a job posting risk analyst. Identify red flags: under-leveling, overqualification, vague JD, toxic signals, unrealistic requirements, high turnover.
Be calibrated — not every startup is a red flag.`

export async function runRiskEvaluator(
  jobContent: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt?: string,
  signal?: AbortSignal
): Promise<RiskResult> {
  const messages: ChatMessage[] = []
  if (customPrompt?.trim()) messages.push({ role: 'system', content: customPrompt.trim() })
  // Include years_of_experience for overqualification/under-leveling detection
  const yearsOfExp = profile.preferences.years_of_experience
  if (yearsOfExp > 0) {
    messages.push({ role: 'system', content: `<candidate_experience>\n<years_of_experience>${yearsOfExp}</years_of_experience>\n</candidate_experience>` })
  }
  messages.push({ role: 'system', content: `Output compact JSON only, no whitespace outside strings:
{"overall_risk":"low","flags":[{"type":"other","description":"","severity":"low"}],"summary":""}` })
  messages.push({ role: 'user', content: `<jd>\n${jobContent}\n</jd>` })
  messages.push({ role: 'user', content: PROMPT })

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
