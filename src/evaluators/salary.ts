import { buildMessages, runWithValidation } from '@/lib/llm-client'
import type { SalaryResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'

const SYSTEM_PROMPT = `You are a compensation analyst. Estimate salary range and assess alignment with candidate expectations.
Consider: role level, location, company, industry, market rates.
Output compact JSON only, no whitespace outside strings:
{"estimated_range":{"min":0,"max":0,"currency":"USD"},"expectation_alignment":"within","risk_flag":false,"reasoning":""}`

export async function runSalaryEvaluator(
  jobMarkdown: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt?: string
): Promise<SalaryResult> {
  const parts: string[] = [`<jd>\n${jobMarkdown}\n</jd>`]
  if (profile.salary_expectation.trim())
    parts.push(`<salary_expectation>\n${profile.salary_expectation.trim()}\n</salary_expectation>`)
  if (profile.preferences.years_of_experience > 0)
    parts.push(`<years_of_experience>${profile.preferences.years_of_experience}</years_of_experience>`)

  return runWithValidation<SalaryResult>(
    config,
    buildMessages(customPrompt, SYSTEM_PROMPT, parts.join('\n\n')),
    (r) => {
      if (!r.estimated_range || typeof r.estimated_range !== 'object')
        return '"estimated_range" must be an object with min/max/currency'
      const range = r.estimated_range as Record<string, unknown>
      if (typeof range.min !== 'number' || typeof range.max !== 'number')
        return '"estimated_range.min" and "max" must be numbers'
      if (!['below', 'within', 'above'].includes(r.expectation_alignment as string))
        return '"expectation_alignment" must be "below", "within", or "above"'
      return null
    }
  )
}
