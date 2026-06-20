import { encode as toonEncode } from '@toon-format/toon'
import type { ChatMessage, JsonSchemaSpec } from '@/lib/llm-client'
import { runAgentWithValidation, executeTool } from '@/lib/agent'
import type { ToolDefinition } from '@/lib/tools/types'
import type { Verdict } from '@/types/evaluation'
import type { LLMConfig } from '@/types/profile'
import type { ToolCall } from '@/lib/tools/types'
import type { ToolExecutor } from '@/lib/agent'
import type { EvaluatorResults } from './aggregator'
import { SUMMARY_SCHEMA } from './schemas'

export const SUMMARY_SCHEMA_NAME = 'summary_result'
export const SUMMARY_JSON_SCHEMA: JsonSchemaSpec = {
  name: SUMMARY_SCHEMA_NAME,
  schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
}

const PROMPT = `<role>
You are a career advisor synthesizing multiple evaluation analyses of a job posting for a candidate.
</role>

<task>
- Write a "job_summary": 1-2 sentences describing what the job is (role, company type, domain) so the candidate instantly knows what they're looking at.
- Write a "reasoning": 2-4 sentences explaining why this role received its score and verdict, focusing on the most important fit signals, any deal-breakers, salary alignment, and growth potential.
</task>

<rules>
- Be direct and actionable — tell the candidate what matters most.
- Do not repeat the score or verdict in "reasoning" — they are already displayed separately.
</rules>`

export interface SummaryResult {
  job_summary: string
  reasoning: string
}

export async function runSummaryEvaluator(
  jobContent: string,
  evaluatorResults: EvaluatorResults,
  score: number,
  verdict: Verdict,
  config: LLMConfig,
  customPrompt: string | undefined,
  tools: ToolDefinition[],
  onToolCall?: (call: ToolCall) => void,
  signal?: AbortSignal,
  jsonSchema?: JsonSchemaSpec,
  exec: ToolExecutor = executeTool,
  verdictToolName?: string
): Promise<SummaryResult> {
  const userContent = `Score: ${score}/100 | Verdict: ${verdict}

<evaluation_results>
${toonEncode(evaluatorResults)}
</evaluation_results>`

  const messages: ChatMessage[] = []
  if (customPrompt?.trim()) messages.push({ role: 'system', content: customPrompt.trim() })
  messages.push({ role: 'system', content: `<jd>\n${jobContent}\n</jd>` })
  messages.push({ role: 'system', content: `Output compact JSON only, no whitespace outside strings:
{"job_summary":"","reasoning":""}` })
  messages.push({ role: 'user', content: PROMPT })
  messages.push({ role: 'user', content: userContent })

  return runAgentWithValidation<SummaryResult>(config, messages, {
    tools,
    executeTool: exec,
    validate: (r) =>
      typeof r.job_summary === 'string' && r.job_summary.trim() &&
      typeof r.reasoning === 'string' && r.reasoning.trim()
        ? null
        : '"job_summary" and "reasoning" must be non-empty strings',
    signal,
    onToolCall,
    jsonSchema,
    verdictToolName,
  })
}
