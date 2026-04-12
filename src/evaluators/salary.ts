import { runWithValidation, buildSalaryContext } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import type { SalaryResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'

const PROMPT = `You are a compensation analyst. Estimate salary range and assess alignment with candidate expectations.

When comparing candidate expectations to the job's compensation:
- Convert all figures to the same currency as the job posting before comparing, using your knowledge of approximate exchange rates. State the conversion in your reasoning.
- If the candidate is based in a different country or region than the job location, account for differences in income tax rates and cost of living. A candidate relocating from a lower-tax or lower-cost region may need a higher gross salary to maintain equivalent take-home pay.
- Base expectation_alignment on this adjusted comparison — not a naive currency number comparison. Explain your reasoning clearly.
- Note that most JDs only disclose the basic salary. Use your knowledge to estimate the pay.
- If the candidate has no salary preference, set expectation_alignment to "within" and risk_flag to false. Still estimate the range.

expectation_alignment semantics (from the CANDIDATE'S perspective):
- "above": the job's range is ABOVE the candidate's expectation → candidate will likely earn more than expected → good outcome
- "within": candidate's expectation falls within the job's range → good match
- "below": the job's range is BELOW the candidate's expectation → role likely underpays → bad outcome
Set risk_flag to true only when alignment is "below" (job underpays) or there is a meaningful risk the offer won't meet expectations.`

export async function runSalaryEvaluator(
  jobContent: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt?: string,
  signal?: AbortSignal
): Promise<SalaryResult> {
  const messages: ChatMessage[] = []
  if (customPrompt?.trim()) messages.push({ role: 'system', content: customPrompt.trim() })
  messages.push({ role: 'system', content: buildSalaryContext(profile) })
  messages.push({ role: 'system', content: `Output compact JSON only, no whitespace outside strings:
{"estimated_range":{"min":0,"max":0,"currency":"USD"},"expectation_alignment":"within","risk_flag":false,"reasoning":""}` })
  messages.push({ role: 'user', content: `<jd>\n${jobContent}\n</jd>` })
  messages.push({ role: 'user', content: PROMPT })

  return runWithValidation<SalaryResult>(
    config,
    messages,
    (r) => {
      if (!r.estimated_range || typeof r.estimated_range !== 'object')
        return '"estimated_range" must be an object with min/max/currency'
      const range = r.estimated_range as Record<string, unknown>
      if (typeof range.min !== 'number' || typeof range.max !== 'number')
        return '"estimated_range.min" and "max" must be numbers'
      if (!['below', 'within', 'above'].includes(r.expectation_alignment as string))
        return '"expectation_alignment" must be "below", "within", or "above"'
      return null
    },
    signal
  )
}
