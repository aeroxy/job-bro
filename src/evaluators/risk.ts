import { buildMessages, runWithValidation } from '@/lib/llm-client'
import type { RiskResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'

const SYSTEM_PROMPT = `You are a job posting risk analyst. Identify red flags: under-leveling, overqualification, vague JD, toxic signals, unrealistic requirements, high turnover.
Be calibrated — not every startup is a red flag.
Output compact JSON only, no whitespace outside strings:
{"overall_risk":"low","flags":[{"type":"other","description":"","severity":"low"}],"summary":""}`

export async function runRiskEvaluator(
  jobMarkdown: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt?: string
): Promise<RiskResult> {
  const parts: string[] = [`<jd>\n${jobMarkdown}\n</jd>`]
  if (profile.resume.trim()) parts.push(`<resume>\n${profile.resume.trim()}\n</resume>`)
  if (profile.preferences.years_of_experience > 0)
    parts.push(`<years_of_experience>${profile.preferences.years_of_experience}</years_of_experience>`)

  return runWithValidation<RiskResult>(
    config,
    buildMessages(customPrompt, SYSTEM_PROMPT, parts.join('\n\n')),
    (r) => {
      if (!['low', 'medium', 'high'].includes(r.overall_risk as string))
        return '"overall_risk" must be "low", "medium", or "high"'
      if (!Array.isArray(r.flags)) return '"flags" must be an array'
      return null
    }
  )
}
