import type { LLMConfig } from '@/types/profile'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string }
    finish_reason: string
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export async function chatCompletion(
  config: LLMConfig,
  messages: ChatMessage[],
  options?: { temperature?: number; max_tokens?: number; json_mode?: boolean }
): Promise<string> {
  const { temperature = 0.3, max_tokens = 2000, json_mode = true } = options ?? {}

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature,
    max_tokens,
  }

  if (json_mode) {
    body.response_format = { type: 'json_object' }
  }

  const baseUrl = config.base_url.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new Error('LLM base URL is not configured')
  const url = `${baseUrl}/chat/completions`

  let lastError: Error | null = null
  // Only retry on HTTP-level errors (429/5xx), not on network failures
  const httpRetryDelays = [1000, 3000]

  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

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
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error')
        const retryable = [429, 500, 502, 503].includes(response.status)

        if (retryable && attempt < 2) {
          lastError = new Error(`HTTP ${response.status}: ${errorText}`)
          await delay(httpRetryDelays[attempt])
          continue
        }

        throw new Error(`LLM API error (${response.status}): ${errorText}`)
      }

      const data: ChatCompletionResponse = await response.json()
      const content = data.choices?.[0]?.message?.content
      if (!content) throw new Error('LLM returned empty response')

      return content
    } catch (e) {
      clearTimeout(timeout)
      // Don't retry on network-level failures (ERR_FAILED, AbortError etc.)
      // — they won't resolve with a simple retry
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  throw lastError ?? new Error('LLM request failed')
}

export function parseJSON<T>(raw: string): T {
  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (fenceMatch) {
      parsed = JSON.parse(fenceMatch[1])
    } else {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0])
      } else {
        throw new Error(`Failed to parse LLM response as JSON: ${raw.slice(0, 200)}`)
      }
    }
  }

  return parsed as T
}

// Validate that all specified fields are finite numbers 0-1.
// Returns an error message string, or null if valid.
export function validateNumbers(
  obj: Record<string, unknown>,
  fields: string[]
): string | null {
  for (const field of fields) {
    const val = obj[field]
    if (typeof val !== 'number' || !isFinite(val) || val < 0 || val > 1) {
      return `"${field}" must be a number 0–1, got ${JSON.stringify(val)}`
    }
  }
  return null
}

// Run an evaluator with one context-aware retry if validation fails.
export async function runWithValidation<T extends Record<string, unknown>>(
  config: LLMConfig,
  messages: ChatMessage[],
  validate: (result: T) => string | null
): Promise<T> {
  const raw = await chatCompletion(config, messages)
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

  const retryRaw = await chatCompletion(config, retryMessages)
  return parseJSON<T>(retryRaw)
}

// Build the messages array with custom prompt and internal prompt as separate system entries
export function buildMessages(
  customPrompt: string | undefined,
  internalPrompt: string,
  userContent: string
): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (customPrompt?.trim()) {
    messages.push({ role: 'system', content: customPrompt.trim() })
  }
  messages.push({ role: 'system', content: internalPrompt })
  messages.push({ role: 'user', content: userContent })
  return messages
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
