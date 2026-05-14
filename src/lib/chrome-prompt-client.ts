// Chrome built-in AI (Gemini Nano) adapter — drop-in for chatCompletion when
// LLMConfig.backend === 'chrome-prompt'. Window-context only; not callable
// from MV3 service workers.

import type { ChatMessage } from './llm-client'

export type ChromeChatOptions = {
  temperature?: number
  json_mode?: boolean
  signal?: AbortSignal
}

type DownloadProgressListener = (loaded: number) => void
const progressListeners = new Set<DownloadProgressListener>()

// App-wide serializer for Chrome AI work. Gemini Nano is one in-process model
// instance: concurrent prompts compete for it (some Chrome builds queue
// gracefully, others throw "model busy"), and concurrent session.create()
// calls each materialize their own KV-cache prefix — running 5 evaluators in
// parallel would peak at 5× the memory for no wall-clock benefit since Chrome
// serializes inference internally anyway.
//
// All entry points to LanguageModel — chatCompletionChrome (evaluators,
// resume) and useChromeChatSession.askChrome (chat) — should run their
// session-touching critical section inside withChromeAiLock so we have a
// single global FIFO across the whole app.
let chromeQueue: Promise<unknown> = Promise.resolve()

export function withChromeAiLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chromeQueue.then(fn, fn)
  // Swallow rejections in the chain so a failed call doesn't poison the queue.
  chromeQueue = next.catch(() => {})
  return next as Promise<T>
}

// Subscribe to download-progress events from any session created via the
// helpers in this module OR via attachDownloadMonitor.
// Returns an unsubscribe fn. Hook this up once from useChromeAiStatus.
export function onChromeDownloadProgress(listener: DownloadProgressListener): () => void {
  progressListeners.add(listener)
  return () => progressListeners.delete(listener)
}

// Returns a monitor function suitable for LanguageModel.create({ monitor }).
// Use this from anywhere that creates its own session (e.g. the persistent
// chat hook) so download progress reaches the same UI listeners.
export function chromeDownloadMonitor(): NonNullable<ChromeAiCreateOptions['monitor']> {
  return (m) => m.addEventListener('downloadprogress', (e) => {
    progressListeners.forEach((l) => l(e.loaded))
  })
}

const PERMISSIVE_JSON_SCHEMA = { type: 'object' } as const

// I/O language declaration required by Chrome to silence the "no output
// language specified" warning and properly attest output safety. Single source
// of truth — every LanguageModel.create() call in the app should pass these.
// Update here when adding multi-language support.
export const DEFAULT_EXPECTED_IO: ChromeAiExpectedIO[] = [{ type: 'text', languages: ['en'] }]

export async function getChromeAiAvailability(): Promise<ChromeAiAvailability> {
  if (typeof globalThis.LanguageModel === 'undefined') return 'unavailable'
  try {
    return await globalThis.LanguageModel.availability()
  } catch {
    return 'unavailable'
  }
}

// Trigger model download (if 'downloadable') without running a prompt.
// Resolves when the model is 'available'; progress flows via onChromeDownloadProgress.
export async function ensureChromeAiDownloaded(signal?: AbortSignal): Promise<void> {
  if (typeof globalThis.LanguageModel === 'undefined') {
    throw new Error('Chrome built-in AI is not available in this browser.')
  }
  const session = await globalThis.LanguageModel.create({
    expectedInputs: DEFAULT_EXPECTED_IO,
    expectedOutputs: DEFAULT_EXPECTED_IO,
    monitor: (m) => m.addEventListener('downloadprogress', (e) => {
      progressListeners.forEach((l) => l(e.loaded))
    }),
    signal,
  })
  session.destroy()
}

export function tempToTopK(temperature: number): number {
  // Heuristic: lower temp → tighter top-K. Chrome accepts roughly 1..40.
  if (temperature <= 0.2) return 1
  if (temperature <= 0.5) return 3
  if (temperature <= 0.8) return 8
  return 20
}

function splitMessages(messages: ChatMessage[]): {
  systemPrompt: string | null
  conversation: ChatMessage[]
} {
  const systems: string[] = []
  const conversation: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') systems.push(m.content)
    else conversation.push(m)
  }
  return {
    systemPrompt: systems.length > 0 ? systems.join('\n\n---\n\n') : null,
    conversation,
  }
}

async function createSession(
  systemPrompt: string | null,
  conversationHead: ChatMessage[],
  temperature: number,
  signal?: AbortSignal,
): Promise<ChromeAiSession> {
  if (typeof globalThis.LanguageModel === 'undefined') {
    throw new Error('Chrome built-in AI is not available in this browser. Open Settings to switch backend.')
  }

  const initialPrompts: ChromeAiPromptMessage[] = []
  if (systemPrompt) initialPrompts.push({ role: 'system', content: systemPrompt })
  for (const m of conversationHead) {
    initialPrompts.push({ role: m.role, content: m.content })
  }

  const opts: ChromeAiCreateOptions = {
    temperature,
    topK: tempToTopK(temperature),
    signal,
    expectedInputs: DEFAULT_EXPECTED_IO,
    expectedOutputs: DEFAULT_EXPECTED_IO,
    monitor: (m) => m.addEventListener('downloadprogress', (e) => {
      progressListeners.forEach((l) => l(e.loaded))
    }),
  }
  if (initialPrompts.length > 0) opts.initialPrompts = initialPrompts

  return globalThis.LanguageModel.create(opts)
}

// Translate ChatMessage[] into a Chrome session call.
// Strategy: system messages → initialPrompts (concatenated); the LAST user message
// is sent via prompt(); any earlier conversation turns ride along as initialPrompts
// so the model has the full history.
export async function chatCompletionChrome(
  messages: ChatMessage[],
  options?: ChromeChatOptions,
): Promise<string> {
  const { temperature = 0.3, json_mode = true, signal } = options ?? {}

  const { systemPrompt, conversation } = splitMessages(messages)
  if (conversation.length === 0) {
    throw new Error('Chrome backend requires at least one non-system message')
  }

  // Last user message becomes the prompt; everything before it seeds the session.
  const last = conversation[conversation.length - 1]
  if (last.role !== 'user') {
    throw new Error('Chrome backend expects the final message to be from the user')
  }
  const head = conversation.slice(0, -1)

  // Serialize against all other Chrome AI work so 5 parallel evaluators don't
  // each materialize a session simultaneously. See withChromeAiLock.
  return withChromeAiLock(async () => {
    if (signal?.aborted) {
      throw new DOMException('chatCompletionChrome aborted before start', 'AbortError')
    }

    let session: ChromeAiSession | null = null
    try {
      session = await createSession(systemPrompt, head, temperature, signal)

      const promptOpts: ChromeAiPromptOptions = { signal }
      if (json_mode) promptOpts.responseConstraint = PERMISSIVE_JSON_SCHEMA

      const out = await session.prompt(last.content, promptOpts)
      if (!out) throw new Error('Chrome AI returned empty response')
      return out
    } finally {
      session?.destroy()
    }
  })
}
