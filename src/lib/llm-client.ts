import { jsonrepair } from 'jsonrepair'

import { chatCompletionChrome } from './chrome-ai-client'
import { sendQwenChat } from './qwen/qwen-service'
import type { LLMConfig, UserProfile } from '@/types/profile'
import type { EvidenceItem } from '@/types/evaluation'
import type { ChatCompletionWithToolsResult, ToolCall, ToolDefinition } from './tools/types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string }
    finish_reason: string
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

// Default completion-token budget. Deliberately generous: reasoning models
// count reasoning_content against max_tokens, so a tight budget (the old
// 2000) gets fully consumed by reasoning and the model returns empty content
// with finish_reason 'length'. Overridable per-provider via config.max_tokens.
const DEFAULT_MAX_TOKENS = 8192

// Shared error for a length-truncated response that produced no usable output —
// almost always a reasoning model exhausting max_tokens on reasoning_content.
function truncatedMessage(maxTokens: number): string {
  return `LLM response truncated at max_tokens (${maxTokens}) before producing output — reasoning models consume this budget on reasoning. Raise "Max Tokens" in settings.`
}

// Per-provider request queue to respect concurrency limits.
// Keyed by base_url to ensure limits apply across multiple evaluator runs.
class RequestQueue {
  private active = 0
  private waiting: { limit: number; resolve: () => void; reject: (err: unknown) => void }[] = []

  async run<T>(concurrency: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const rawLimit = Number.isFinite(concurrency) ? concurrency : 2
    const limit = Math.max(1, Math.min(10, Math.round(rawLimit)))

    if (signal?.aborted) {
      throw new DOMException('The user aborted a request.', 'AbortError')
    }

    if (this.active >= limit) {
      await new Promise<void>((resolve, reject) => {
        const waiter = { limit, resolve, reject }
        this.waiting.push(waiter)

        const onAbort = () => {
          if (signal) {
            signal.removeEventListener('abort', onAbort)
          }
          const idx = this.waiting.indexOf(waiter)
          if (idx !== -1) {
            this.waiting.splice(idx, 1)
          }
          reject(new DOMException('The user aborted a request.', 'AbortError'))
        }

        if (signal) {
          signal.addEventListener('abort', onAbort)
        }

        waiter.resolve = () => {
          if (signal) {
            signal.removeEventListener('abort', onAbort)
          }
          resolve()
        }
      })
    } else {
      this.active++
    }

    if (signal?.aborted) {
      this.active--
      this.processQueue()
      throw new DOMException('The user aborted a request.', 'AbortError')
    }

    try {
      return await fn()
    } finally {
      this.active--
      this.processQueue()
    }
  }

  private processQueue() {
    for (let i = 0; i < this.waiting.length; i++) {
      const { limit, resolve } = this.waiting[i]
      if (this.active < limit) {
        this.active++
        this.waiting.splice(i, 1)
        resolve()
        i-- // Adjust index after removal
      }
    }
  }
}

const queues = new Map<string, RequestQueue>()

function getQueue(baseUrl: string): RequestQueue {
  let q = queues.get(baseUrl)
  if (!q) {
    q = new RequestQueue()
    queues.set(baseUrl, q)
  }
  return q
}

// Some reasoning models (e.g. MiniMax) emit their chain-of-thought inline as a
// leading <think>…</think> block in `content` instead of a separate
// reasoning_content field. Strip a leading block so downstream JSON parsing and
// display see only the answer. Only a leading block is removed; if the closing
// tag is missing (truncated reasoning), the content is left untouched.
export function stripThinkBlock(content: string): string {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('<think>')) return content
  const close = trimmed.indexOf('</think>')
  // No close tag → the response was cut off inside the reasoning block, so the
  // real answer never arrived. Return '' rather than the half-written thoughts:
  // parseJSON's `{…}` regex would otherwise latch onto a brace inside the
  // reasoning and yield a garbage-but-parseable object.
  if (close === -1) return ''
  return trimmed.slice(close + '</think>'.length).trimStart()
}

export async function chatCompletion(
  config: LLMConfig,
  messages: ChatMessage[],
  options?: { temperature?: number; max_tokens?: number; json_mode?: boolean; signal?: AbortSignal }
): Promise<string> {
  if (config.backend === 'chrome-prompt') {
    return chatCompletionChrome(messages, {
      temperature: options?.temperature ?? config.temperature,
      json_mode: options?.json_mode,
      signal: options?.signal,
    })
  }

  // Delegate to the Qwen agent backend. Qwen is NOT an LLM we call — it's
  // a server-side agent with native web search, read-page, and thinking.
  // We hand the whole research task off and get a finished answer back;
  // the extension's own tools (`WEB_SEARCH_TOOL`, `READ_PAGE_TOOL`) are
  // irrelevant here. `chatCompletion` / `chatCompletionWithTools` share
  // this entry point for API symmetry, but the semantics differ: on the
  // Qwen branch we're dispatching to an agent, not prompting a model.
  //
  // Offscreen documents don't have `chrome.cookies`, so detect that
  // context and bridge the request to the background service worker.
  if (config.backend === 'qwen-chat') {
    const qwenMessages = messages.map(({ role, content }) => ({ role, content }));
    // Concurrency control. Qwen's anti-bot WAF throttles bursts — all 6
    // evaluators firing at once trips the "被挤爆啦" overload/punish response.
    // Gate through the same per-provider queue the cloud path uses, keyed by a
    // constant since Qwen has no base_url. Default 2, user-configurable via
    // config.concurrency. The queue lives in this realm (the offscreen, for the
    // analysis path), so it caps the bridged requests across all evaluators
    // before they fan out to the background. A request that's mid-back-off
    // (anti-bot retry, 30s apart) keeps holding its slot, which is the desired
    // backpressure — it stops the other evaluators from piling on.
    const concurrency = config.concurrency ?? 2;
    return getQueue('qwen-chat').run(concurrency, async () => {
      if (options?.signal?.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      if (typeof chrome !== 'undefined' && !chrome.cookies) {
        const requestId = crypto.randomUUID();
        const sendPromise = chrome.runtime.sendMessage({
          type: 'QWEN_CHAT_REQUEST',
          requestId,
          messages: qwenMessages,
        });

        if (!options?.signal) {
          const resp = await sendPromise;
          if (!resp?.ok) {
            throw new Error(resp?.error || 'Failed to delegate Qwen Chat request to background.');
          }
          return resp.result;
        }

        let onAbort: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          onAbort = () => {
            chrome.runtime.sendMessage({
              type: 'QWEN_CHAT_CANCEL',
              requestId,
            }).catch(() => {});
            reject(new DOMException('The user aborted a request.', 'AbortError'));
          };
          options.signal!.addEventListener('abort', onAbort);
        });

        try {
          const resp = await Promise.race([sendPromise, abortPromise]);
          if (!resp?.ok) {
            if (resp?.isAbort) {
              throw new DOMException('The user aborted a request.', 'AbortError');
            }
            throw new Error(resp?.error || 'Failed to delegate Qwen Chat request to background.');
          }
          return resp.result;
        } finally {
          if (onAbort) {
            options.signal.removeEventListener('abort', onAbort);
          }
        }
      }
      if (options?.signal?.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      return sendQwenChat(qwenMessages, options?.signal);
    }, options?.signal);
  }

  const queue = getQueue(config.base_url)
  const concurrency = config.concurrency ?? 2

  return queue.run(concurrency, async () => {
    if (config.stream_mode) {
      return streamCompletion(config, messages, options)
    }

    const { json_mode = true, signal } = options ?? {}
    const temperature = options?.temperature ?? config.temperature
    const max_tokens = options?.max_tokens ?? config.max_tokens ?? DEFAULT_MAX_TOKENS
    const timeoutMs = (config.timeout ?? 30) * 1000

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      max_tokens,
    }
    // Only send temperature when explicitly configured — otherwise let the
    // provider apply its own default (some reasoning models reject or ignore it).
    if (temperature !== undefined) body.temperature = temperature

    if (json_mode) {
      body.response_format = { type: 'json_object' }
    }

    const baseUrl = config.base_url.trim().replace(/\/+$/, '')
    if (!baseUrl) throw new Error('LLM base URL is not configured')
    const url = `${baseUrl}/chat/completions`

    let lastError: Error | null = null
    const httpRetryDelays = [3000, 10000]

    for (let attempt = 0; attempt <= 2; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs)

      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }

        if (config.api_key) {
          headers['Authorization'] = `Bearer ${config.api_key}`
        }

        if (config.custom_headers) {
          try {
            Object.assign(headers, JSON.parse(config.custom_headers))
          } catch {
            // ignore malformed custom headers
          }
        }

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        })

        clearTimeout(timeout)

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error')
          const retryable = [429, 500, 502, 503, 504].includes(response.status)

          if (retryable && attempt < 2) {
            lastError = new Error(`HTTP ${response.status}: ${errorText}`)
            await delay(httpRetryDelays[attempt])
            continue
          }

          throw new Error(`LLM API error (${response.status}): ${errorText}`)
        }

        const data: ChatCompletionResponse = await response.json()
        const choice = data.choices?.[0]
        const content = choice?.message?.content
        if (!content) {
          if (choice?.finish_reason === 'length') throw new Error(truncatedMessage(max_tokens))
          throw new Error('LLM returned empty response')
        }

        return stripThinkBlock(content)
      } catch (e) {
        clearTimeout(timeout)
        if (isTransientNetworkError(e, signal) && attempt < 2) {
          lastError = e instanceof Error ? e : new Error(String(e))
          await delay(httpRetryDelays[attempt])
          continue
        }
        throw e instanceof Error ? e : new Error(String(e))
      }
    }

    throw lastError ?? new Error('LLM request failed')
  }, options?.signal)
}

export function parseJSON<T>(raw: string): T {
  // Strip a markdown code fence if present, else isolate the outermost object.
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  const objectMatch = raw.match(/\{[\s\S]*\}/)
  const candidate = fenceMatch ? fenceMatch[1] : objectMatch ? objectMatch[0] : raw

  // A bare "null"/primitive parses fine but then crashes the validators with an
  // opaque "Cannot read properties of null" — reject it here with a clear error.
  const asObject = (val: unknown): T => {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) throw new Error('not a JSON object')
    return val as T
  }

  try {
    return asObject(JSON.parse(candidate))
  } catch {
    // LLMs routinely emit unescaped quotes/newlines inside strings, trailing
    // commas, or truncated tails. jsonrepair fixes the common cases before we
    // give up — a last resort, not the happy path.
    try {
      return asObject(JSON.parse(jsonrepair(candidate)))
    } catch (e) {
      throw new Error(`Failed to parse LLM response as JSON: ${(e as Error).message}: ${raw.slice(0, 200)}`)
    }
  }
}

// Validate that all specified fields are finite numbers 0-1.
// Returns an error message string, or null if valid.
export function validateNumbers(
  obj: object,
  fields: string[]
): string | null {
  const record = obj as Record<string, unknown>
  for (const field of fields) {
    const val = record[field]
    if (typeof val !== 'number' || !isFinite(val) || val < 0 || val > 1) {
      return `"${field}" must be a number 0–1, got ${JSON.stringify(val)}`
    }
  }
  return null
}

// Run an evaluator with one context-aware retry if validation fails.
export async function runWithValidation<T extends object>(
  config: LLMConfig,
  messages: ChatMessage[],
  validate: (result: T) => string | null,
  signal?: AbortSignal
): Promise<T> {
  const raw = await chatCompletion(config, messages, { signal })
  const result = parseJSON<T>(raw)

  const error = validate(result)
  if (!error) return result

  // Reprompt with the bad response in context so the model understands what went wrong
  const retryMessages: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: raw },
    {
      role: 'user',
      content: `Invalid response: ${error}. Fix it and output compact JSON only.`,
    },
  ]

  const retryRaw = await chatCompletion(config, retryMessages, { signal })
  return parseJSON<T>(retryRaw)
}

async function streamCompletion(
  config: LLMConfig,
  messages: ChatMessage[],
  options?: { temperature?: number; max_tokens?: number; json_mode?: boolean; signal?: AbortSignal }
): Promise<string> {
  const { json_mode = true, signal } = options ?? {}
  const temperature = options?.temperature ?? config.temperature
  const max_tokens = options?.max_tokens ?? config.max_tokens ?? DEFAULT_MAX_TOKENS
  const inactivityMs = (config.stream_timeout ?? 60) * 1000

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens,
    stream: true,
  }
  if (temperature !== undefined) body.temperature = temperature

  if (json_mode) {
    body.response_format = { type: 'json_object' }
  }

  const baseUrl = config.base_url.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new Error('LLM base URL is not configured')
  const url = `${baseUrl}/chat/completions`

  let lastError: Error | null = null
  const httpRetryDelays = [3000, 10000]

  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController()
    let inactivityTimer: ReturnType<typeof setTimeout>
    const resetTimer = () => {
      clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => controller.abort(new DOMException('Stream timed out', 'TimeoutError')), inactivityMs)
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }

      if (config.api_key) {
        headers['Authorization'] = `Bearer ${config.api_key}`
      }

      if (config.custom_headers) {
        try {
          Object.assign(headers, JSON.parse(config.custom_headers))
        } catch {
          // ignore malformed custom headers
        }
      }

      resetTimer()
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      })

      if (!response.ok) {
        clearTimeout(inactivityTimer!)
        const errorText = await response.text().catch(() => 'Unknown error')
        const retryable = [429, 500, 502, 503, 504].includes(response.status)

        if (retryable && attempt < 2) {
          lastError = new Error(`HTTP ${response.status}: ${errorText}`)
          await delay(httpRetryDelays[attempt])
          continue
        }

        throw new Error(`LLM API error (${response.status}): ${errorText}`)
      }

      if (!response.body) throw new Error('Response body is null — streaming not supported by this endpoint')

      resetTimer()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let content = ''
      let finishReason: string | undefined
      let done = false

      const consume = (data: string) => {
        const parsed = JSON.parse(data)
        const delta = parsed.choices?.[0]?.delta?.content
        if (typeof delta === 'string') content += delta
        const fr = parsed.choices?.[0]?.finish_reason
        if (typeof fr === 'string') finishReason = fr
      }

      while (!done) {
        const { value, done: streamDone } = await reader.read()
        if (streamDone) break
        resetTimer()

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') { done = true; break }
          try { consume(data) } catch { /* malformed chunk, skip */ }
        }
      }

      // Flush remaining buffer
      buffer += decoder.decode()
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') break
        try { consume(data) } catch { /* malformed chunk, skip */ }
      }

      clearTimeout(inactivityTimer!)
      if (!content) {
        if (finishReason === 'length') throw new Error(truncatedMessage(max_tokens))
        throw new Error('LLM returned empty streaming response')
      }
      return stripThinkBlock(content)

    } catch (e) {
      clearTimeout(inactivityTimer!)
      if (isTransientNetworkError(e, signal) && attempt < 2) {
        lastError = e instanceof Error ? e : new Error(String(e))
        await delay(httpRetryDelays[attempt])
        continue
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  throw lastError ?? new Error('LLM streaming request failed')
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// fetch() rejects on a dropped connection with a TypeError, and our request
// timeout aborts with a DOMException named 'TimeoutError'. Both are transient
// and worth retrying. An external/user abort (signal.aborted) is deliberate, so
// never retry that — nor the API/parse Errors we throw ourselves (plain Error).
function isTransientNetworkError(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false
  if (e instanceof DOMException) return e.name === 'TimeoutError'
  return e instanceof TypeError
}

// Tool-aware variant of chatCompletion. Returns the raw model message so the
// caller can inspect tool_calls. For Chrome AI backend tools are not supported
// (Gemini Nano has no tool API); the LLM still gets the messages and returns
// a plain string content with no tool_calls — the agent loop terminates after
// the first iteration. Non-streaming only.
export async function chatCompletionWithTools(
  config: LLMConfig,
  messages: ChatMessage[],
  options: {
    tools: ToolDefinition[]
    tool_choice?: 'auto' | 'required' | 'none'
    temperature?: number
    max_tokens?: number
    signal?: AbortSignal
    jsonSchema?: JsonSchemaSpec
  }
): Promise<ChatCompletionWithToolsResult> {
  if (config.backend === 'chrome-prompt') {
    const content = await chatCompletionChrome(messages, {
      temperature: options.temperature ?? config.temperature,
      signal: options.signal,
    })
    return { content }
  }

  if (config.backend === 'qwen-chat') {
    const content = await chatCompletion(config, messages, {
      temperature: options.temperature,
      signal: options.signal,
    })
    return { content }
  }

  const queue = getQueue(config.base_url)
  const concurrency = config.concurrency ?? 2
  return queue.run(concurrency, () => toolCompletionRequest(config, messages, options), options.signal)
}

// JSON Schema spec passed to providers that support OpenAI's strict
// response_format.json_schema. `name` must match /^[a-zA-Z_][a-zA-Z0-9_-]*$/
// per OpenAI's spec. The schema must be a JSON Schema object.
export interface JsonSchemaSpec {
  name: string
  schema: Record<string, unknown>
}

async function toolCompletionRequest(
  config: LLMConfig,
  messages: ChatMessage[],
  options: {
    tools: ToolDefinition[]
    tool_choice?: 'auto' | 'required' | 'none'
    temperature?: number
    max_tokens?: number
    signal?: AbortSignal
    jsonSchema?: JsonSchemaSpec
  }
): Promise<ChatCompletionWithToolsResult> {
  const { tools, tool_choice = 'auto', signal, jsonSchema } = options
  const temperature = options.temperature ?? config.temperature
  const max_tokens = options.max_tokens ?? config.max_tokens ?? DEFAULT_MAX_TOKENS
  const timeoutMs = (config.timeout ?? 30) * 1000

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens,
  }
  // Only advertise tools when there are any. Some OpenAI-compatible backends
  // reject an empty `tools: []` (with `tool_choice`), and tools are disabled
  // precisely by resolving to an empty array.
  if (tools.length > 0) {
    body.tools = tools
    body.tool_choice = tool_choice
  }
  if (temperature !== undefined) body.temperature = temperature

  // Strict structured output: server-side guarantees the response matches the
  // declared shape, which removes the parse-and-retry path entirely. Only
  // emitted when the caller explicitly passes a schema; without it, the
  // default OpenAI json_object mode is used (set by the provider when tools
  // are present, or handled by the inline prompt example).
  if (jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: jsonSchema.name,
        schema: jsonSchema.schema,
        strict: true,
      },
    }
  }

  const baseUrl = config.base_url.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new Error('LLM base URL is not configured')
  const url = `${baseUrl}/chat/completions`

  const httpRetryDelays = [3000, 10000]
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
      timeoutMs
    )

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (config.api_key) headers['Authorization'] = `Bearer ${config.api_key}`
      if (config.custom_headers) {
        try {
          Object.assign(headers, JSON.parse(config.custom_headers))
        } catch {
          /* ignore malformed custom headers */
        }
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      })

      clearTimeout(timer)

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error')
        const retryable = [429, 500, 502, 503, 504].includes(response.status)
        if (retryable && attempt < 2) {
          lastError = new Error(`HTTP ${response.status}: ${errorText}`)
          await delay(httpRetryDelays[attempt])
          continue
        }
        throw new Error(`LLM API error (${response.status}): ${errorText}`)
      }

      const data = (await response.json()) as ChatCompletionResponse
      const choice = data.choices?.[0]
      const message = choice?.message
      if (!message) throw new Error('LLM returned empty response')

      const tool_calls = (message as { tool_calls?: ToolCall[] }).tool_calls
      const hasToolCalls = Array.isArray(tool_calls) && tool_calls.length > 0
      // Reasoning model that burned the whole budget on reasoning_content:
      // length cutoff, no content, no tool_calls. Fail with an actionable
      // message instead of returning '' and tripping a JSON parse error.
      if (choice?.finish_reason === 'length' && !message.content && !hasToolCalls) {
        throw new Error(truncatedMessage(max_tokens))
      }
      return {
        content: stripThinkBlock(message.content ?? ''),
        tool_calls: hasToolCalls ? tool_calls : undefined,
      }
    } catch (e) {
      clearTimeout(timer)
      if (isTransientNetworkError(e, signal) && attempt < 2) {
        lastError = e instanceof Error ? e : new Error(String(e))
        await delay(httpRetryDelays[attempt])
        continue
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  throw lastError ?? new Error('LLM request failed')
}

// --- Per-evaluator context builders ---

const PROFILE_PREAMBLE = `You are an AI career evaluation agent. You will analyze job postings against a candidate's profile.`

// Resume + projects — for job-fit and growth evaluators
export function buildResumeContext(profile: UserProfile): string {
  const parts: string[] = [PROFILE_PREAMBLE, '']
  if (profile.resume.trim()) {
    parts.push(`<resume>\n${profile.resume.trim()}\n</resume>`, '')
  }
  if (profile.projects.trim()) {
    parts.push(`<projects>\n${profile.projects.trim()}\n</projects>`, '')
  }
  return parts.join('\n').trimEnd()
}

// Salary expectation only — for salary evaluator
// Returns the expectation text, or a no-preference sentinel if empty
export function buildSalaryContext(profile: UserProfile): string {
  const expectation = profile.salary_expectation.trim()
  if (!expectation) return 'Candidate has no salary preference.'
  return `<salary_expectation>\n${expectation}\n</salary_expectation>`
}

// Preferences only — for preference evaluator
export function buildPreferencesContext(profile: UserProfile): string {
  const prefs = profile.preferences
  const parts: string[] = []
  const remoteLabel = prefs.remote_preference === 'no_preference' ? 'No Preference' : prefs.remote_preference
  const sizeLabel = prefs.company_size_preference === 'no_preference' ? 'No Preference' : prefs.company_size_preference
  parts.push(`<remote_preference>${remoteLabel}</remote_preference>`)
  if (prefs.preferred_locations.trim())
    parts.push(`<preferred_locations>${prefs.preferred_locations.trim()}</preferred_locations>`)
  parts.push(`<company_size_preference>${sizeLabel}</company_size_preference>`)
  if (prefs.industries_of_interest.trim())
    parts.push(`<industries_of_interest>${prefs.industries_of_interest.trim()}</industries_of_interest>`)
  if (prefs.deal_breakers.trim())
    parts.push(`<deal_breakers>${prefs.deal_breakers.trim()}</deal_breakers>`)
  if (prefs.years_of_experience > 0)
    parts.push(`<years_of_experience>${prefs.years_of_experience}</years_of_experience>`)
  return `<preferences>\n${parts.join('\n')}\n</preferences>`
}

// Sources gathered by upstream evaluators, injected into the downstream stage
// (risk, growth) so they inherit prior research instead of re-searching. We
// pass the distilled {title,url,snippet} — not the full page markdown — to keep
// the prompt lean; a downstream read_page on a listed URL is a cache hit.
// Returns null when there's nothing to inject (no system message added).
export function buildPriorResearchContext(evidences: EvidenceItem[]): string | null {
  if (!evidences.length) return null
  const lines = evidences.map((e) => {
    const snippet = e.snippet?.trim() ? ` — ${e.snippet.trim()}` : ''
    return `- ${e.title?.trim() || e.url} (${e.url})${snippet}`
  })
  return `Earlier analysis steps already researched this company/role and found the sources below. Treat them as known context. Only call web_search / read_page if you need detail they don't cover — re-reading a listed URL is cheap (it's cached), but don't repeat searches that produced these.

<prior_research>
${lines.join('\n')}
</prior_research>`
}

