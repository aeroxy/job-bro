import { validateNumbers, buildResumeContext, buildPreferencesContext } from '@/lib/llm-client'
import type { ChatMessage, JsonSchemaSpec } from '@/lib/llm-client'
import { runAgentWithValidation, executeTool } from '@/lib/agent'
import type { ToolDefinition } from '@/lib/tools/types'
import type { GrowthResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'
import type { ToolCall } from '@/lib/tools/types'
import { GROWTH_SCHEMA } from './schemas'

export const GROWTH_SCHEMA_NAME = 'growth_result'
export const GROWTH_JSON_SCHEMA: JsonSchemaSpec = {
  name: GROWTH_SCHEMA_NAME,
  schema: GROWTH_SCHEMA as unknown as Record<string, unknown>,
}

// Growth is the most candidate-relative of the five evaluators: the same JD
// can be a great growth move for one person and a dead end for another.
// Score from the CANDIDATE'S perspective, using their resume, projects, and
// stated preferences as the reference frame.
const PROMPT = `You are a career strategist evaluating the GROWTH POTENTIAL of this specific role for THIS specific candidate. Growth is candidate-relative — a "good growth role" depends on where the candidate already is and where they want to go.

Process:
1. Read the candidate's resume + projects to establish their CURRENT level: what tech they already know, what domains they've shipped in, what seniority / scope they've held, what companies / brands they've already earned on their resume.
2. Read the candidate's preferences to establish their TARGETS: industries of interest, years of experience, deal breakers, and any implicit signals (e.g. preferred locations, company size).
3. Compare the JD against (1) and (2). Score each growth axis by how much it moves the candidate FORWARD from their current state toward (or away from) their targets.

Scoring axes:
- learning_opportunity (0–1): how much genuinely NEW technical ground does this role cover that the candidate hasn't already shipped in? Higher = more new tech, new domain, new scale. A lateral move in the same stack/domain should score LOW (0.1–0.3). A pivot into a new domain the candidate has only touched lightly should score HIGH (0.7–0.9). A pure repeat of what they already do well should score 0.0–0.2.
- brand_value (0–1): how much does adding this company / role to the resume INCREASE the candidate's market brand from where they are today? Higher = well-known brand, hot industry, in-demand skill, or a clearly senior scope. A move from a less-known company to a household-name company scores HIGH. A move between two equally well-known companies scores MID. A move from a strong brand to a much weaker or unknown brand scores LOW.
- career_trajectory (0–1): does this role push the candidate UP the seniority / scope / impact curve from where they are? Higher = a clear promotion in scope, a step into a new specialization they've been building toward, or an entry into a target industry. Lower = a lateral move, a step down in scope, or a detour away from their stated industries of interest. Cap at 0.3 if the role represents a step DOWN in scope or seniority relative to what the candidate has already held.
- overall_growth (0–1): a holistic blend. Do not just average the three axes — weight learning + trajectory more heavily than brand_value, since brand is a means to an end. If the role is high-learning but low-trajectory (e.g. an IC role when the candidate is clearly targeting staff/principal), overall_growth should be moderate, not high.

Critical calibration rules:
- DO NOT default to 0.0. Zero is a strong claim that the role offers no learning, no brand lift, and no trajectory bump. Only emit 0.0 axes when the role is genuinely a flat repeat of what the candidate already does. When in doubt, anchor at 0.5 (neutral) and reason in the summary.
- "highlights" must be SPECIFIC to this candidate. Generic positives ("great team", "interesting work") are useless. Good: "Move into the fintech domain — a target industry for the candidate" or "Step from 5-person startup scope to 200-person company scope".
- "concerns" must be SPECIFIC to this candidate. Surface any axis where the role is a step sideways or backwards for them.
- If the candidate's preferences include "industries of interest" and the JD's industry is on that list, that is a positive growth signal (industry alignment, target trajectory). If the JD's industry is unrelated and the candidate has no signal of wanting to pivot, do not over-credit it.
- DO NOT score on salary, location, or remote — those are evaluated separately.

Evidences: if you used web_search or read_page (e.g. to gauge employer brand recognition, tech stack adoption, or industry heat), list the sources you actually relied on in an "evidences" array of {"title":"","url":"","snippet":""}. If you didn't use any tools, emit "evidences": [].`

export async function runGrowthEvaluator(
  jobContent: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt: string,
  tools: ToolDefinition[],
  onToolCall?: (call: ToolCall) => void,
  signal?: AbortSignal,
  jsonSchema?: JsonSchemaSpec
): Promise<GrowthResult> {
  const messages: ChatMessage[] = []
  if (customPrompt) messages.push({ role: 'system', content: customPrompt })
  messages.push({ role: 'system', content: buildResumeContext(profile) })
  // Preferences give the model the candidate's stated targets (industries of
  // interest, deal breakers, etc.) — essential for candidate-relative scoring.
  messages.push({ role: 'system', content: buildPreferencesContext(profile) })
  messages.push({ role: 'system', content: `Output compact JSON only, no whitespace outside strings:
{"learning_opportunity":0.0,"brand_value":0.0,"career_trajectory":0.0,"overall_growth":0.0,"highlights":[],"concerns":[],"summary":"","evidences":[]}` })
  messages.push({ role: 'user', content: `<jd>\n${jobContent}\n</jd>` })
  messages.push({ role: 'user', content: PROMPT })

  return runAgentWithValidation<GrowthResult>(
    config,
    messages,
    {
      tools,
      executeTool,
      validate: (r) => {
        const base = validateNumbers(r, [
          'learning_opportunity', 'brand_value', 'career_trajectory', 'overall_growth',
        ]) ??
          (Array.isArray(r.highlights) && Array.isArray(r.concerns)
            ? null
            : '"highlights" and "concerns" must be arrays')
        if (base) return base
        if (typeof r.summary !== 'string' || !r.summary.trim()) return '"summary" must be a non-empty string'
        if (r.evidences !== undefined && !Array.isArray(r.evidences)) return '"evidences" must be an array'
        return null
      },
      signal,
      onToolCall,
      jsonSchema,
    }
  )
}
