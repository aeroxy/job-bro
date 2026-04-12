
import type { LLMConfig, UserProfile } from '@/types/profile'

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
  options?: { temperature?: number; max_tokens?: number; json_mode?: boolean; signal?: AbortSignal }
): Promise<string> {
  if (config.stream_mode) {
    return streamCompletion(config, messages, options)
  }

  const { temperature = 0.3, max_tokens = 2000, json_mode = true, signal } = options ?? {}
  const timeoutMs = (config.timeout ?? 30) * 1000

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
  const httpRetryDelays = [1000, 3000]

  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

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

async function streamCompletion(
  config: LLMConfig,
  messages: ChatMessage[],
  options?: { temperature?: number; max_tokens?: number; json_mode?: boolean; signal?: AbortSignal }
): Promise<string> {
  const { temperature = 0.3, max_tokens = 2000, json_mode = true, signal } = options ?? {}
  const inactivityMs = (config.stream_timeout ?? 60) * 1000

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature,
    max_tokens,
    stream: true,
  }

  if (json_mode) {
    body.response_format = { type: 'json_object' }
  }

  const baseUrl = config.base_url.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new Error('LLM base URL is not configured')
  const url = `${baseUrl}/chat/completions`

  let lastError: Error | null = null
  const httpRetryDelays = [1000, 3000]

  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController()
    let inactivityTimer: ReturnType<typeof setTimeout>
    const resetTimer = () => {
      clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => controller.abort(), inactivityMs)
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
        const retryable = [429, 500, 502, 503].includes(response.status)

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
      let done = false

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
          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta?.content
            if (typeof delta === 'string') content += delta
          } catch { /* malformed chunk, skip */ }
        }
      }

      // Flush remaining buffer
      buffer += decoder.decode()
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') break
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta?.content
          if (typeof delta === 'string') content += delta
        } catch { /* malformed chunk, skip */ }
      }

      clearTimeout(inactivityTimer!)
      if (!content) throw new Error('LLM returned empty streaming response')
      return content

    } catch (e) {
      clearTimeout(inactivityTimer!)
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  throw lastError ?? new Error('LLM streaming request failed')
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
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

