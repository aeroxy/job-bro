import { buildMessages, runWithValidation, validateNumbers } from '@/lib/llm-client'
import type { PreferenceResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'

const SYSTEM_PROMPT = `You are a career advisor comparing job preferences vs job posting.
Check remote/onsite, location, company size, industry, deal breakers.
Output compact JSON only, no whitespace outside strings:
{"alignment_score":0.0,"conflicts":[{"category":"","expected":"","actual":"","severity":"low"}],"matches":[],"summary":""}`

export async function runPreferenceEvaluator(
  jobMarkdown: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt?: string
): Promise<PreferenceResult> {
  const prefs = profile.preferences
  const prefLines: string[] = []
  if (prefs.remote_preference !== 'any') prefLines.push(`Remote preference: ${prefs.remote_preference}`)
  if (prefs.preferred_locations.length > 0) prefLines.push(`Preferred locations: ${prefs.preferred_locations.join(', ')}`)
  if (prefs.company_size_preference !== 'any') prefLines.push(`Company size: ${prefs.company_size_preference}`)
  if (prefs.industries_of_interest.length > 0) prefLines.push(`Industries: ${prefs.industries_of_interest.join(', ')}`)
  if (prefs.deal_breakers.length > 0) prefLines.push(`Deal breakers: ${prefs.deal_breakers.join(', ')}`)

  const parts: string[] = [`<jd>\n${jobMarkdown}\n</jd>`]
  if (prefLines.length > 0)
    parts.push(`<preferences>\n${prefLines.join('\n')}\n</preferences>`)

  return runWithValidation<PreferenceResult>(
    config,
    buildMessages(customPrompt, SYSTEM_PROMPT, parts.join('\n\n')),
    (r) =>
      validateNumbers(r as Record<string, unknown>, ['alignment_score']) ??
      (Array.isArray(r.conflicts) && Array.isArray(r.matches)
        ? null
        : '"conflicts" and "matches" must be arrays')
  )
}
