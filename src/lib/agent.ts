// Agent loop: drives the LLM through tool use until it produces a final
// content message (no tool_calls). Each iteration:
//   1. Send messages → chatCompletionWithTools
//   2. If response has tool_calls:
//        append assistant message
//        for each call: append tool result via executeTool()
//   3. Else: return content
// Caps iterations to prevent runaway.

import { chatCompletionWithTools, parseJSON } from './llm-client'
import type { ChatMessage } from './llm-client'
import type { LLMConfig } from '@/types/profile'
import type { ToolCall, ToolDefinition } from './tools/types'
import { googleSearch, readPage } from './tools/handlers'

export const MAX_AGENT_ITERATIONS = 8

export type ToolExecutor = (call: ToolCall, signal?: AbortSignal) => Promise<string>

export interface AgentOptions {
  tools: ToolDefinition[]
  executeTool: ToolExecutor
  signal?: AbortSignal
  onToolCall?: (call: ToolCall) => void
  maxIterations?: number
}

// Generic tool executor — works in any extension page (service worker,
// sidepanel). Routes google_search and read_page to their handlers. The
// service worker manages the offscreen document lifecycle; both contexts
// share the same `fetch` + offscreen-message plumbing.
export const executeTool: ToolExecutor = async (call, signal) => {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments)
  } catch {
    throw new Error(`Tool ${call.function.name} received malformed arguments`)
  }
  switch (call.function.name) {
    case 'google_search': {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('google_search requires a non-empty query')
      return googleSearch(query, { signal })
    }
    case 'read_page': {
      const url = String(args.url ?? '').trim()
      if (!url) throw new Error('read_page requires a non-empty url')
      return readPage(url, { signal })
    }
    default:
      throw new Error(`Unknown tool: ${call.function.name}`)
  }
}

export async function runAgent(
  config: LLMConfig,
  messages: ChatMessage[],
  options: AgentOptions
): Promise<string> {
  const { tools, executeTool, signal, onToolCall, maxIterations = MAX_AGENT_ITERATIONS } = options
  const working: ChatMessage[] = [...messages]

  for (let i = 0; i < maxIterations; i++) {
    if (signal?.aborted) {
      throw new DOMException('Agent aborted', 'AbortError')
    }
    const response = await chatCompletionWithTools(config, working, { tools, signal })

    if (!response.tool_calls?.length) {
      return response.content
    }

    working.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.tool_calls,
    } as ChatMessage)

    for (const call of response.tool_calls) {
      onToolCall?.(call)
      let result: string
      try {
        result = await executeTool(call, signal)
      } catch (e) {
        result = `Error: ${(e as Error).message}`
      }
      console.log(`[Tool Call] name: ${call.function.name}, arguments: ${call.function.arguments}`, result)
      working.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      } as ChatMessage)
    }
  }

  throw new Error(`Agent exceeded ${maxIterations} iterations without a final answer`)
}

// Agent-aware replacement for runWithValidation. Runs the agent loop, parses
// the final content as JSON, validates, and retries once on parse/validation
// failure with the bad response in context so the model can self-correct.
export async function runAgentWithValidation<T extends object>(
  config: LLMConfig,
  messages: ChatMessage[],
  options: AgentOptions & { validate: (result: T) => string | null }
): Promise<T> {
  const { validate, ...agentOpts } = options

  const raw = await runAgent(config, messages, agentOpts)
  try {
    const parsed = parseJSON<T>(raw)
    const error = validate(parsed)
    if (!error) return parsed
    return await retry<T>(config, messages, agentOpts, raw, error)
  } catch (parseError) {
    return await retry<T>(config, messages, agentOpts, raw, `Could not parse JSON: ${(parseError as Error).message}`)
  }
}

async function retry<T extends object>(
  config: LLMConfig,
  messages: ChatMessage[],
  agentOpts: AgentOptions,
  badResponse: string,
  errorMessage: string
): Promise<T> {
  const retryMessages: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: badResponse },
    { role: 'user', content: `${errorMessage}. Fix it and output compact JSON only.` },
  ]
  const retryRaw = await runAgent(config, retryMessages, agentOpts)
  return parseJSON<T>(retryRaw)
}
