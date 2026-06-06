import { encode as toonEncode } from '@toon-format/toon'
import type { ChatMessage } from '@/lib/llm-client'
import { runAgentWithValidation, executeTool } from '@/lib/agent'
import { ALL_TOOLS } from '@/lib/tools/definitions'
import type { Verdict } from '@/types/evaluation'
import type { LLMConfig } from '@/types/profile'
import type { EvaluatorResults } from './aggregator'

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
  customPrompt?: string,
  signal?: AbortSignal
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
    tools: ALL_TOOLS,
    executeTool,
    validate: (r) =>
      typeof r.job_summary === 'string' && typeof r.reasoning === 'string'
        ? null
        : '"job_summary" and "reasoning" must be strings',
    signal,
  })
}
