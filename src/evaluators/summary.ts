import { chatCompletion } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import type { Verdict } from '@/types/evaluation'
import type { LLMConfig } from '@/types/profile'
import type { EvaluatorResults } from './aggregator'

const SYSTEM_PROMPT = `<role>
You are a career advisor synthesizing multiple evaluation analyses of a job posting for a candidate.
</role>

<task>
Given the evaluation results in the user message, write a concise 2-4 sentence summary explaining
why this role received its score and verdict.
</task>

<rules>
- Focus on: the most important fit signals, any deal-breakers, salary alignment, and growth potential.
- Be direct and actionable — tell the candidate what matters most.
- Do not repeat the score or verdict — they are already displayed separately.
</rules>

<output_format>
IMPORTANT: Output plain prose only — 2 to 4 sentences. No JSON, no markdown, no bullet points, no headers, no code fences. Your entire response must be plain text.
</output_format>`

export async function runSummaryEvaluator(
  sharedPrefix: ChatMessage[],
  config: LLMConfig,
  evaluatorResults: EvaluatorResults,
  score: number,
  verdict: Verdict,
  signal?: AbortSignal
): Promise<string> {
  const userContent = `Score: ${score}/100 | Verdict: ${verdict}

<evaluation_results>
${JSON.stringify(evaluatorResults, null, 2)}
</evaluation_results>`

  const messages: ChatMessage[] = [
    ...sharedPrefix,
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ]

  return await chatCompletion(config, messages, {
    json_mode: false,
    max_tokens: 500,
    temperature: 0.3,
    signal,
  })
}
