// Agent loop: drives the LLM through tool use until it produces a final
// content message (no tool_calls). Each iteration:
//   1. Send messages → chatCompletionWithTools
//   2. If response has tool_calls:
//        append assistant message
//        for each call: append tool result via executeTool()
//   3. Else: return content
// Caps iterations to prevent runaway.

import { chatCompletionWithTools, parseJSON } from './llm-client'
import type { ChatMessage, JsonSchemaSpec } from './llm-client'
import type { LLMConfig } from '@/types/profile'
import type { ToolCall, ToolDefinition } from './tools/types'
import { webSearch, readPage } from './tools/handlers'

// Hard cap on the agent loop to prevent runaway.
export const MAX_AGENT_ITERATIONS = 10
// After this many rounds, tools are disabled — the model must produce a
// final content message. Gives the agent time to research, then forces it
// to answer instead of looping forever.
const MAX_TOOL_ROUNDS = 5

export type ToolExecutor = (call: ToolCall, signal?: AbortSignal) => Promise<string>

export interface AgentOptions {
  tools: ToolDefinition[]
  executeTool: ToolExecutor
  signal?: AbortSignal
  onToolCall?: (call: ToolCall) => void
  maxIterations?: number
  // Optional JSON Schema for strict structured output. When set, every call
  // in the agent loop passes response_format.json_schema so the model can't
  // drift shape — eliminates the parseJSON/validate retry path for providers
  // that support it (OpenAI, Groq, Together, vLLM, etc.). Ignored by Chrome
  // backend. Evaluators thread this from config.structured_output.
  jsonSchema?: JsonSchemaSpec
}

// Generic tool executor — works in any extension page (service worker,
// sidepanel). Routes web_search and read_page to their handlers. The
// service worker manages the offscreen document lifecycle; both contexts
// share the same `fetch` + offscreen-message plumbing.
export const executeTool: ToolExecutor = async (call, signal) => {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments)
    // JSON.parse succeeds on `"null"`, `"42"`, `"[]"`, etc.; guard so the
    // property access below can't be a non-object (typeof [] is 'object' too).
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object')
  } catch {
    throw new Error(`Tool ${call.function.name} received malformed arguments`)
  }
  switch (call.function.name) {
    case 'web_search': {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('web_search requires a non-empty query')
      return webSearch(query, { signal })
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

// Build a stable cache key for a tool call so identical web_search / read_page
// calls resolve to one fetch. Returns null for calls we shouldn't cache
// (malformed args, unknown tool) so they always hit the network.
function toolCacheKey(call: ToolCall): string | null {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments)
    // JSON.parse succeeds on `"null"`, `"42"`, `"[]"`, etc.; guard so the
    // property access below can't be a non-object (matches executeTool).
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  } catch {
    return null
  }
  switch (call.function.name) {
    case 'web_search': {
      const q = String(args.query ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
      return q ? `search:${q}` : null
    }
    case 'read_page': {
      const raw = String(args.url ?? '').trim()
      if (!raw) return null
      try {
        // new URL() already lowercases the case-insensitive parts (scheme +
        // host); don't lowercase the whole thing — path/query are
        // case-sensitive, so doing so would collide distinct pages onto one key.
        const u = new URL(raw)
        u.hash = ''
        return `read:${u.toString()}`
      } catch {
        return `read:${raw}`
      }
    }
    default:
      return null
  }
}

// Wrap a ToolExecutor with a per-run cache so the same company page / search
// isn't fetched once per evaluator. Promises are cached (not just results), so
// concurrent identical calls share a single in-flight fetch; a rejected call
// is evicted so a transient failure can be retried. Create one per analysis run
// and share it across all evaluators — the staged pipeline means downstream
// evaluators (risk, growth) reuse pages already fetched upstream for free.
export function createCachedExecutor(base: ToolExecutor = executeTool): ToolExecutor {
  const inflight = new Map<string, Promise<string>>()
  return (call, signal) => {
    const key = toolCacheKey(call)
    if (!key) return base(call, signal)
    const existing = inflight.get(key)
    if (existing) return existing
    const p = base(call, signal).catch((e) => {
      inflight.delete(key)
      throw e
    })
    inflight.set(key, p)
    return p
  }
}

// Returns the final content plus the accumulated transcript (assistant tool
// calls + tool results). Callers that retry on a bad final answer reuse
// `messages` so the retry keeps the gathered tool context instead of
// re-researching from scratch.
export async function runAgent(
  config: LLMConfig,
  messages: ChatMessage[],
  options: AgentOptions
): Promise<{ content: string; messages: ChatMessage[] }> {
  const { tools, executeTool, signal, onToolCall, maxIterations = MAX_AGENT_ITERATIONS, jsonSchema } = options
  const working: ChatMessage[] = [...messages]

  for (let i = 0; i < maxIterations; i++) {
    if (signal?.aborted) {
      throw new DOMException('Agent aborted', 'AbortError')
    }
    // After MAX_TOOL_ROUNDS, strip tools so the model is forced to produce
    // a final content message instead of continuing to call tools. Still up
    // to MAX_AGENT_ITERATIONS total iterations are available for retries.
    const activeTools = i < MAX_TOOL_ROUNDS ? tools : []
    const response = await chatCompletionWithTools(config, working, { tools: activeTools, signal, jsonSchema })

    if (!response.tool_calls?.length) {
      return { content: response.content, messages: working }
    }

    working.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.tool_calls,
    } as ChatMessage)

    // Tool calls in a single turn are independent network requests — run them
    // concurrently. .map() preserves order, so the pushed tool results still
    // line up with response.tool_calls; the cached executor dedups any
    // identical concurrent calls.
    const toolResults = await Promise.all(
      response.tool_calls.map(async (call) => {
        onToolCall?.(call)
        let result: string
        try {
          result = await executeTool(call, signal)
        } catch (e) {
          result = `Error: ${e instanceof Error ? e.message : String(e)}`
        }
        return {
          role: 'tool' as const,
          tool_call_id: call.id,
          content: result,
        }
      })
    )
    working.push(...(toolResults as ChatMessage[]))
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

  // Reuse the agent's accumulated transcript (tool calls + results) on retry so
  // the correction step keeps the gathered context instead of re-researching.
  const { content: raw, messages: history } = await runAgent(config, messages, agentOpts)
  try {
    const parsed = parseJSON<T>(raw)
    const error = validate(parsed)
    if (!error) return parsed
    return await retry<T>(config, history, agentOpts, raw, error, validate)
  } catch (parseError) {
    return await retry<T>(config, history, agentOpts, raw, `Could not parse JSON: ${(parseError as Error).message}`, validate)
  }
}

async function retry<T extends object>(
  config: LLMConfig,
  history: ChatMessage[],
  agentOpts: AgentOptions,
  badResponse: string,
  errorMessage: string,
  validate: (result: T) => string | null
): Promise<T> {
  const retryMessages: ChatMessage[] = [
    ...history,
    { role: 'assistant', content: badResponse },
    { role: 'user', content: `${errorMessage}. Fix it and output compact JSON only.` },
  ]
  const { content: retryRaw } = await runAgent(config, retryMessages, agentOpts)
  // Re-validate the retry too — otherwise invalid-but-parseable JSON would slip
  // through and callers' Promise<T> contract (and downstream scoring) breaks.
  const parsed = parseJSON<T>(retryRaw)
  const error = validate(parsed)
  if (error) throw new Error(`Validation failed after retry: ${error}`)
  return parsed
}
