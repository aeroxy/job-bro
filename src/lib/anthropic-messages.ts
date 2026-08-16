// Translation between our OpenAI-shaped ChatMessage / ToolDefinition types and
// Anthropic's Messages API (`POST {base_url}/messages`). Pure functions only —
// the fetch, retry, queueing and error handling stay in llm-client.ts so every
// keyed backend shares one policy.

import type { ChatMessage, JsonSchemaSpec } from './llm-client'
import type { ToolCall, ToolDefinition } from './tools/types'
import type { LLMConfig } from '@/types/profile'

export const ANTHROPIC_VERSION = '2023-06-01'

// The default 5-minute TTL. Writes cost 1.25x base input, reads 0.1x, so a
// breakpoint pays for itself on its second read — unlike the OpenAI side, where
// prefix caching is automatic and unpriced.
const EPHEMERAL = { type: 'ephemeral' } as const

type RequestBlock =
  | { type: 'text'; text: string; cache_control?: typeof EPHEMERAL }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; cache_control?: typeof EPHEMERAL }
  | { type: 'tool_result'; tool_use_id: string; content: string; cache_control?: typeof EPHEMERAL }

interface RequestMessage {
  role: 'user' | 'assistant'
  content: RequestBlock[]
}

// Only the response fields we read. Unknown block types are ignored.
export interface AnthropicResponse {
  content?: Array<{
    type: string
    text?: string
    id?: string
    name?: string
    input?: Record<string, unknown>
    // thinking / redacted_thinking. We never read these — they exist so the
    // blocks can be echoed back verbatim; see `readAnthropicResponse`.
    thinking?: string
    signature?: string
    data?: string
  }>
  stop_reason?: string | null
  stop_details?: { category?: string | null; explanation?: string | null } | null
}

export interface AnthropicBodyOptions {
  max_tokens: number
  temperature?: number
  // Strict server-side JSON (`output_config.format`). Only pass it when the
  // model supports it and no tools are in play.
  jsonSchema?: JsonSchemaSpec
  tools?: ToolDefinition[]
  tool_choice?: 'auto' | 'required' | 'none'
  // SSE. Always on in practice — see llm-client's `postSSE`.
  stream?: boolean
}

export interface AnthropicReadResult {
  content: string
  tool_calls?: ToolCall[]
  stopReason?: string | null
  // Category / explanation from `stop_details`, when the request was declined.
  refusalDetail?: string
  // `thinking` / `redacted_thinking` blocks, verbatim and in order. Opaque —
  // nothing reads their contents; they exist only to be handed back on the next
  // turn. See `readAnthropicResponse` for why that is mandatory.
  reasoning_blocks?: unknown[]
}

// Our flat ChatMessage list → Anthropic's `system` + `messages`.
//
// Three shape differences to bridge: system turns are hoisted out (Anthropic
// takes them as a top-level field, and rejects a system message at any other
// position), `tool` turns become `tool_result` blocks on a *user* turn, and
// assistant `tool_calls` become `tool_use` blocks. Turns with the same role are
// merged, which is what puts a whole round of parallel tool results into one
// user turn — splitting them teaches the model to stop calling tools in parallel.
export function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string
  messages: RequestMessage[]
} {
  const system: string[] = []
  const out: RequestMessage[] = []

  const append = (role: RequestMessage['role'], blocks: RequestBlock[]) => {
    if (!blocks.length) return
    const last = out[out.length - 1]
    if (last?.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim()) system.push(message.content)
      continue
    }

    if (message.role === 'tool') {
      // An empty tool_use_id is a 400 with no useful body. Name it here — the
      // agent loop always carries the id, so hitting this means a caller built
      // the transcript by hand and lost the pairing.
      if (!message.tool_call_id) {
        throw new Error('Anthropic: a tool result is missing its tool_call_id, so it cannot be paired with a tool_use block.')
      }
      append('user', [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          // An empty block is rejected, and "no output" is itself the result.
          content: message.content || '(no output)',
        },
      ])
      continue
    }

    const blocks: RequestBlock[] = []
    // Reasoning first: Anthropic requires a turn's thinking blocks to lead it,
    // ahead of any text or tool_use. Cast because they are opaque passthrough —
    // we hand back exactly what the model sent.
    if (message.reasoning_blocks?.length) {
      blocks.push(...(message.reasoning_blocks as RequestBlock[]))
    }
    if (message.content.trim()) blocks.push({ type: 'text', text: message.content })
    for (const call of message.tool_calls ?? []) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: asObject(call.function.arguments) })
    }
    append(message.role, blocks)
  }

  // `system` is a separate field here, so a prompt built only from system turns
  // converts to an empty `messages` array — which the API rejects as flatly as
  // it would a missing model, and just as opaquely.
  if (!out.length) {
    throw new Error('Anthropic: a request needs at least one user or assistant message, but only system turns were given.')
  }

  // Anthropic reads a *trailing* assistant turn as a prefill and rejects one
  // whose last text block ends in whitespace. No current caller ends the array
  // on an assistant turn — the agent loop always appends a tool result or a
  // user nudge — but this is a general translator, so normalise the single spot
  // the API is strict about rather than trimming every assistant turn (which
  // would silently edit mid-conversation history the model already produced).
  const tail = out[out.length - 1]
  if (tail?.role === 'assistant') {
    const last = tail.content[tail.content.length - 1]
    if (last?.type === 'text') last.text = last.text.trimEnd()
  }

  return { system: system.length ? system.join('\n\n') : undefined, messages: out }
}

export function buildAnthropicBody(
  config: LLMConfig,
  messages: ChatMessage[],
  options: AnthropicBodyOptions
): Record<string, unknown> {
  const { system, messages: converted } = toAnthropicMessages(messages)

  // max_tokens is required by this API, not optional as on the OpenAI side.
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: options.max_tokens,
    messages: converted,
  }
  // A block array rather than a bare string, so the system prompt can carry a
  // cache breakpoint. It holds the custom prompt plus the candidate's resume and
  // preferences — the largest constant in the request and identical across every
  // call of a run, so it's the one entry most worth writing once and reading
  // back on every later call.
  if (system) {
    body.system = [{ type: 'text', text: system, cache_control: EPHEMERAL }]
  }
  // Omitted when unset so the provider's default applies. Recent Claude models
  // (Opus 5, Sonnet 5, Opus 4.7+) reject an explicit temperature outright, and
  // any model rejects one alongside thinking — which Opus 5 has on by default.
  if (options.temperature !== undefined) body.temperature = options.temperature

  // Second breakpoint, on the last block of the last turn — the multi-turn
  // pattern. The system entry alone only covers tools + system, so an agent
  // loop re-sent the JD, the previous assistant turn and every tool_result at
  // full price on each iteration. Measured on a real capture: a second turn
  // read 1,516 tokens and paid for 8,391, most of it a page dump it had
  // already sent. Cheap to place — reads accrue incrementally as the
  // conversation grows, and each turn adds far fewer than the 20 blocks a
  // breakpoint looks back over.
  const lastTurn = converted[converted.length - 1]
  const lastBlock = lastTurn?.content[lastTurn.content.length - 1]
  // Thinking blocks are replayed verbatim and take no cache_control, so skip
  // anything that isn't one of the three block types that accept it.
  if (lastBlock && (lastBlock.type === 'text' || lastBlock.type === 'tool_result' || lastBlock.type === 'tool_use')) {
    lastBlock.cache_control = EPHEMERAL
  }

  if (options.stream) body.stream = true

  if (options.jsonSchema) {
    body.output_config = {
      format: { type: 'json_schema', schema: options.jsonSchema.schema },
    }
  }

  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }))
    body.tool_choice = { type: TOOL_CHOICE[options.tool_choice ?? 'auto'] }
  }

  return body
}

const TOOL_CHOICE = { auto: 'auto', required: 'any', none: 'none' } as const

// Response content blocks → the OpenAI-shaped result the agent loop expects.
// `tool_use` blocks are re-serialised as `tool_calls` so `lib/agent.ts` and the
// `provide_verdict` channel work unchanged across backends.
export function readAnthropicResponse(data: AnthropicResponse): AnthropicReadResult {
  const blocks = data.content ?? []

  const content = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')

  const tool_calls: ToolCall[] = blocks
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id ?? crypto.randomUUID(),
      type: 'function' as const,
      function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
    }))

  // Thinking blocks have to survive the round trip. When thinking is on — and
  // on Claude Opus 5 it is on by default, with no `thinking` field sent — the
  // API requires the assistant turn that made a tool call to still carry its
  // thinking blocks, unchanged, when the matching tool_result comes back;
  // dropping them fails the next request on ordering/signature grounds. So the
  // agent loop can't just keep text and tool_calls, which is all it needs
  // itself: it has to carry these along too.
  //
  // An unsigned thinking block is rejected in its own right, so one that
  // reached us without a signature (a proxy that strips it, say) is dropped
  // rather than echoed — that reproduces the old behaviour instead of
  // guaranteeing a 400.
  const reasoning = blocks.filter(
    (block) =>
      (block.type === 'thinking' && block.signature) ||
      (block.type === 'redacted_thinking' && block.data)
  )

  const detail = [data.stop_details?.category, data.stop_details?.explanation]
    .filter((part): part is string => !!part)
    .join(': ')

  return {
    content,
    tool_calls: tool_calls.length ? tool_calls : undefined,
    stopReason: data.stop_reason,
    refusalDetail: detail || undefined,
    reasoning_blocks: reasoning.length ? reasoning : undefined,
  }
}

// Tool arguments reach us as a JSON string; this API wants the object.
// Malformed or truncated JSON becomes `{}` rather than dropping the call: the
// transcript still lines up with its `tool_result`, and the handler's own
// "requires a non-empty query" error goes back to the model as something it can
// act on. Dropping the block would strand the tool_use with no result.
function asObject(json: string): Record<string, unknown> {
  if (!json.trim()) return {}
  try {
    const parsed = JSON.parse(json) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* fall through */
  }
  // Silent `{}` is the right wire behaviour but a miserable thing to debug —
  // the tool then fails on its own "requires a non-empty query" error, which
  // reads like a model mistake rather than truncated/mangled JSON.
  console.warn('[anthropic] discarded malformed tool-call arguments:', json.slice(0, 200))
  return {}
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

// The SSE event fields we act on. Everything else (`ping`, usage) is ignored.
export interface AnthropicStreamEvent {
  type?: string
  index?: number
  content_block?: { type?: string; id?: string; name?: string; data?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    signature?: string
    partial_json?: string
    stop_reason?: string | null
    stop_details?: AnthropicResponse['stop_details']
  }
  error?: { type?: string; message?: string }
}

interface StreamBlock {
  type: string
  id?: string
  name?: string
  // Text or thinking, whichever this block carries.
  text: string
  // `input_json_delta` fragments for a tool_use block, concatenated.
  json: string
  // A thinking block's signature, and a redacted_thinking block's payload. Both
  // are opaque and both must be echoed back verbatim — hence captured, not read.
  signature?: string
  data?: string
}

export interface AnthropicStreamState {
  blocks: StreamBlock[]
  stopReason?: string | null
  stopDetails?: AnthropicResponse['stop_details']
}

export function newAnthropicStreamState(): AnthropicStreamState {
  return { blocks: [] }
}

// Folds one SSE event into `state`.
//
// Streamed tool calls are the reason this exists: a `tool_use` block's arguments
// arrive as `input_json_delta` fragments that are only valid JSON once
// concatenated, so nothing can be interpreted until the stream ends.
export function applyAnthropicStreamEvent(
  state: AnthropicStreamState,
  event: AnthropicStreamEvent
): void {
  switch (event.type) {
    case 'content_block_start': {
      state.blocks[event.index ?? state.blocks.length] = {
        type: event.content_block?.type ?? 'text',
        id: event.content_block?.id,
        name: event.content_block?.name,
        // redacted_thinking carries its whole payload on the start event.
        data: event.content_block?.data,
        text: '',
        json: '',
      }
      return
    }

    case 'content_block_delta': {
      const block = state.blocks[event.index ?? 0]
      if (!block) return
      switch (event.delta?.type) {
        case 'text_delta':
          block.text += event.delta.text ?? ''
          return
        case 'thinking_delta':
          block.text += event.delta.thinking ?? ''
          return
        case 'input_json_delta':
          block.json += event.delta.partial_json ?? ''
          return
        case 'signature_delta':
          // Never read, but a thinking block is invalid without it, so it has to
          // be kept for the echo back — see `readAnthropicResponse`.
          block.signature = (block.signature ?? '') + (event.delta.signature ?? '')
          return
        default:
          // Anything newer: nothing for us to accumulate.
          return
      }
    }

    case 'message_delta': {
      if (event.delta?.stop_reason !== undefined) state.stopReason = event.delta.stop_reason
      if (event.delta?.stop_details !== undefined) state.stopDetails = event.delta.stop_details
      return
    }

    default:
      return
  }
}

// Collapses the accumulated stream into the same shape a non-streaming response
// has, so `readAnthropicResponse` stays the only place that interprets a reply.
export function finishAnthropicStream(state: AnthropicStreamState): AnthropicResponse {
  return {
    content: state.blocks.filter(Boolean).map((block) => {
      switch (block.type) {
        case 'tool_use':
          return { type: block.type, id: block.id, name: block.name, input: asObject(block.json) }
        // Rebuilt in the API's own shape rather than ours, because these two get
        // handed straight back on the next turn.
        case 'thinking':
          return { type: block.type, thinking: block.text, signature: block.signature }
        case 'redacted_thinking':
          return { type: block.type, data: block.data }
        default:
          return { type: block.type, text: block.text }
      }
    }),
    stop_reason: state.stopReason,
    stop_details: state.stopDetails,
  }
}
