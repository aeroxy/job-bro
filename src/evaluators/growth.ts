import { buildMessages, runWithValidation, validateNumbers } from '@/lib/llm-client'
import type { GrowthResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'

const SYSTEM_PROMPT = `You are a career strategist evaluating growth potential of a role.
Assess: learning opportunity (new skills/tech), company brand value for resume, career trajectory.
Output compact JSON only, no whitespace outside strings:
{"learning_opportunity":0.0,"brand_value":0.0,"career_trajectory":0.0,"overall_growth":0.0,"highlights":[],"concerns":[],"summary":""}`

export async function runGrowthEvaluator(
  jobMarkdown: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt?: string
): Promise<GrowthResult> {
  const parts: string[] = [`<jd>\n${jobMarkdown}\n</jd>`]
  if (profile.resume.trim()) parts.push(`<resume>\n${profile.resume.trim()}\n</resume>`)
  if (profile.projects.trim()) parts.push(`<projects>\n${profile.projects.trim()}\n</projects>`)

  return runWithValidation<GrowthResult>(
    config,
    buildMessages(customPrompt, SYSTEM_PROMPT, parts.join('\n\n')),
    (r) =>
      validateNumbers(r as Record<string, unknown>, [
        'learning_opportunity', 'brand_value', 'career_trajectory', 'overall_growth',
      ]) ??
      (Array.isArray(r.highlights) && Array.isArray(r.concerns)
        ? null
        : '"highlights" and "concerns" must be arrays')
  )
}
