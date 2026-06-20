import { validateNumbers, buildPreferencesContext } from '@/lib/llm-client'
import type { ChatMessage, JsonSchemaSpec } from '@/lib/llm-client'
import { runAgentWithValidation, executeTool } from '@/lib/agent'
import type { ToolDefinition } from '@/lib/tools/types'
import type { PreferenceResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'
import type { ToolCall } from '@/lib/tools/types'
import type { ToolExecutor } from '@/lib/agent'
import { PREFERENCE_SCHEMA } from './schemas'

export const PREFERENCE_SCHEMA_NAME = 'preference_result'
export const PREFERENCE_JSON_SCHEMA: JsonSchemaSpec = {
  name: PREFERENCE_SCHEMA_NAME,
  schema: PREFERENCE_SCHEMA as unknown as Record<string, unknown>,
}

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

Use concise, direct language. Do not include a title or heading — start directly with **Location:**.

Evidences: if you used web_search or read_page (e.g. to verify the company's actual HQ/team size, or to look up a public industry classification), list the sources you actually relied on in an "evidences" array of {"title":"","url":"","snippet":""}. If you didn't use any tools, emit "evidences": [].`

export async function runPreferenceEvaluator(
  jobContent: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt: string,
  tools: ToolDefinition[],
  onToolCall?: (call: ToolCall) => void,
  signal?: AbortSignal,
  jsonSchema?: JsonSchemaSpec,
  exec: ToolExecutor = executeTool,
  verdictName?: string
): Promise<PreferenceResult> {
  const messages: ChatMessage[] = []
  if (customPrompt) messages.push({ role: 'system', content: customPrompt })
  messages.push({ role: 'system', content: buildPreferencesContext(profile) })
  messages.push({ role: 'system', content: `Output compact JSON only, no whitespace outside strings:
{"alignment_score":0.0,"conflicts":[{"category":"","expected":"","actual":"","severity":"low"}],"matches":[],"summary":"","evidences":[]}` })
  messages.push({ role: 'user', content: `<jd>\n${jobContent}\n</jd>` })
  messages.push({ role: 'user', content: PROMPT })

  return runAgentWithValidation<PreferenceResult>(
    config,
    messages,
    {
      tools,
      executeTool: exec,
      validate: (r) => {
        const base = validateNumbers(r, ['alignment_score']) ??
          (Array.isArray(r.conflicts) && Array.isArray(r.matches)
            ? null
            : '"conflicts" and "matches" must be arrays')
        if (base) return base
        if (typeof r.summary !== 'string' || !r.summary.trim()) return '"summary" must be a non-empty string'
        if (r.evidences !== undefined && !Array.isArray(r.evidences)) return '"evidences" must be an array'
        return null
      },
      signal,
      onToolCall,
      jsonSchema,
      verdictName,
    }
  )
}
