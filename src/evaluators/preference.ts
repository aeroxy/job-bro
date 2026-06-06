import { validateNumbers, buildPreferencesContext } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import { runAgentWithValidation, executeTool } from '@/lib/agent'
import { ALL_TOOLS } from '@/lib/tools/definitions'
import type { PreferenceResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'

const PROMPT = `You are a career advisor comparing job preferences vs job posting.
Identify 'Remote/Onsite' status and 'Employment Type' (e.g., Contract, Full-time) by scanning the full Description text.
Check remote/onsite, location, company size, industry, deal breakers.

Write the "summary" field as a structured markdown report covering only the candidate's stated preferences:
- **Location:** whether it matches preferred locations (use ✓ or ✗)
- **Remote Work:** remote/hybrid/onsite status vs preference (use ✓ or ✗)
- **Company Size:** how it matches the preference (use ✓ or ✗)
- **Industry:** only if candidate has industries of interest — whether it matches (use ✓ or ✗); omit otherwise
- **Deal Breakers:** bullet list of any conflicts (omit section if none)
- A short closing sentence on overall preference alignment

Use concise, direct language. Do not include a title or heading — start directly with **Location:**.`

export async function runPreferenceEvaluator(
  jobContent: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt: string,
  signal?: AbortSignal
): Promise<PreferenceResult> {
  const messages: ChatMessage[] = []
  if (customPrompt) messages.push({ role: 'system', content: customPrompt })
  messages.push({ role: 'system', content: buildPreferencesContext(profile) })
  messages.push({ role: 'system', content: `Output compact JSON only, no whitespace outside strings:
{"alignment_score":0.0,"conflicts":[{"category":"","expected":"","actual":"","severity":"low"}],"matches":[],"summary":""}` })
  messages.push({ role: 'user', content: `<jd>\n${jobContent}\n</jd>` })
  messages.push({ role: 'user', content: PROMPT })

  return runAgentWithValidation<PreferenceResult>(
    config,
    messages,
    {
      tools: ALL_TOOLS,
      executeTool,
      validate: (r) =>
        validateNumbers(r, ['alignment_score']) ??
        (Array.isArray(r.conflicts) && Array.isArray(r.matches)
          ? null
          : '"conflicts" and "matches" must be arrays'),
      signal,
    }
  )
}
