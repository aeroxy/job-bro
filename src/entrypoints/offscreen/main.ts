// Offscreen document: hosts both the HTML→markdown parser (used by the agent
// tools) and Chrome's built-in AI (Gemini Nano) session — both need a window
// context that the MV3 service worker doesn't have. Lives at
// chrome-extension://<id>/offscreen.html; created eagerly by the background
// service worker via chrome.offscreen.
//
// Concurrency: every Chrome AI call goes through `withChromeAiLock`, a single
// FIFO queue, so concurrent callers (service worker evaluators, sidepanel
// chat, download trigger) all serialize on the one in-process model.

import { parseGenericPage, parseGoogleSearchResults } from '@/lib/html-to-markdown'
import type { ChatMessage } from '@/lib/llm-client'

type ParseRequest = { type: 'PARSE_HTML'; html: string; mode: 'google_search' | 'read_page' }

type SessionCreateRequest = {
  type: 'CHROME_AI_SESSION_CREATE'
  systemPrompt: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  temperature?: number
}
type SessionPromptRequest = {
  type: 'CHROME_AI_SESSION_PROMPT'
  sessionId: string
  content: string
  jsonMode?: boolean
}
type SessionDestroyRequest = { type: 'CHROME_AI_SESSION_DESTROY'; sessionId: string }
type ChatRequest = {
  type: 'CHROME_AI_CHAT'
  messages: ChatMessage[]
  temperature?: number
  jsonMode?: boolean
}
type AvailabilityRequest = { type: 'CHROME_AI_AVAILABILITY' }
type DownloadRequest = { type: 'CHROME_AI_DOWNLOAD' }

type ChromeAiRequest =
  | ChatRequest
  | AvailabilityRequest
  | DownloadRequest
  | SessionCreateRequest
  | SessionPromptRequest
  | SessionDestroyRequest

// --- FIFO queue ---

let chromeAiQueue: Promise<unknown> = Promise.resolve()

function withChromeAiLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chromeAiQueue.then(fn, fn)
  chromeAiQueue = next.catch(() => {})
  return next as Promise<T>
}

// --- Session store ---

const sessions = new Map<string, ChromeAiSession>()

function nextSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

const PERMISSIVE_JSON_SCHEMA = { type: 'object' } as const
const DEFAULT_EXPECTED_IO: ChromeAiExpectedIO[] = [{ type: 'text', languages: ['en'] }]

function tempToTopK(temperature: number): number {
  if (temperature <= 0.2) return 1
  if (temperature <= 0.5) return 3
  if (temperature <= 0.8) return 8
  return 20
}

function broadcastDownloadProgress(loaded: number) {
  // Send to all extension pages (sidepanel, etc.) and the service worker.
  // The originating offscreen is the sender; receivers filter by type.
  try {
    chrome.runtime.sendMessage({ type: 'CHROME_AI_DOWNLOAD_PROGRESS', loaded }).catch(() => {})
  } catch {
    /* no listeners */
  }
}

function downloadMonitor() {
  return (m: ChromeAiCreateMonitor) => m.addEventListener('downloadprogress', (e: ChromeAiDownloadProgressEvent) => {
    broadcastDownloadProgress(e.loaded)
  })
}

async function createSessionInternal(req: SessionCreateRequest): Promise<string> {
  if (typeof globalThis.LanguageModel === 'undefined') {
    throw new Error('Chrome built-in AI is not available in this browser.')
  }
  const temperature = req.temperature ?? 0.3
  const initialPrompts: ChromeAiPromptMessage[] = [{ role: 'system', content: req.systemPrompt }]
  for (const t of req.history) initialPrompts.push({ role: t.role, content: t.content })

  const session = await globalThis.LanguageModel.create({
    initialPrompts,
    temperature,
    topK: tempToTopK(temperature),
    expectedInputs: DEFAULT_EXPECTED_IO,
    expectedOutputs: DEFAULT_EXPECTED_IO,
    monitor: downloadMonitor(),
  })
  const id = nextSessionId()
  sessions.set(id, session)
  return id
}

async function promptSessionInternal(req: SessionPromptRequest): Promise<string> {
  const session = sessions.get(req.sessionId)
  if (!session) throw new Error(`Unknown Chrome AI session: ${req.sessionId}`)
  const opts: ChromeAiPromptOptions = {}
  if (req.jsonMode) opts.responseConstraint = PERMISSIVE_JSON_SCHEMA
  const out = await session.prompt(req.content, opts)
  if (!out) throw new Error('Chrome AI returned an empty response')
  return out
}

function destroySessionInternal(req: SessionDestroyRequest): void {
  const session = sessions.get(req.sessionId)
  if (session) {
    try { session.destroy() } catch { /* best-effort */ }
    sessions.delete(req.sessionId)
  }
}

function splitMessages(messages: ChatMessage[]): {
  systemPrompt: string | null
  conversation: ChatMessage[]
} {
  const systems: string[] = []
  const conversation: ChatMessage[] = []
  for (const m of messages) {
    // Chrome's LanguageModel doesn't accept 'tool' messages; the agent
    // terminates after one iteration for this backend so they don't appear
    // in practice, but filter defensively for type safety.
    if (m.role === 'tool') continue
    if (m.role === 'system') systems.push(m.content)
    else conversation.push(m)
  }
  return {
    systemPrompt: systems.length > 0 ? systems.join('\n\n---\n\n') : null,
    conversation,
  }
}

async function oneShotChatInternal(req: ChatRequest): Promise<string> {
  if (typeof globalThis.LanguageModel === 'undefined') {
    throw new Error('Chrome built-in AI is not available in this browser.')
  }
  const { systemPrompt, conversation } = splitMessages(req.messages)
  if (conversation.length === 0) {
    throw new Error('Chrome backend requires at least one non-system message')
  }
  const last = conversation[conversation.length - 1]
  if (last.role !== 'user') {
    throw new Error('Chrome backend expects the final message to be from the user')
  }
  const head = conversation.slice(0, -1)
  const temperature = req.temperature ?? 0.3

  const initialPrompts: ChromeAiPromptMessage[] = []
  if (systemPrompt) initialPrompts.push({ role: 'system', content: systemPrompt })
  for (const m of head) {
    if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') {
      initialPrompts.push({ role: m.role, content: m.content })
    }
  }

  const session = await globalThis.LanguageModel.create({
    initialPrompts,
    temperature,
    topK: tempToTopK(temperature),
    expectedInputs: DEFAULT_EXPECTED_IO,
    expectedOutputs: DEFAULT_EXPECTED_IO,
    monitor: downloadMonitor(),
  })
  try {
    const opts: ChromeAiPromptOptions = {}
    if (req.jsonMode !== false) opts.responseConstraint = PERMISSIVE_JSON_SCHEMA
    const out = await session.prompt(last.content, opts)
    if (!out) throw new Error('Chrome AI returned an empty response')
    return out
  } finally {
    try { session.destroy() } catch { /* best-effort */ }
  }
}

async function getAvailabilityInternal(): Promise<ChromeAiAvailability> {
  if (typeof globalThis.LanguageModel === 'undefined') return 'unavailable'
  try {
    return await globalThis.LanguageModel.availability()
  } catch {
    return 'unavailable'
  }
}

async function downloadInternal(): Promise<void> {
  if (typeof globalThis.LanguageModel === 'undefined') {
    throw new Error('Chrome built-in AI is not available in this browser.')
  }
  const session = await globalThis.LanguageModel.create({
    expectedInputs: DEFAULT_EXPECTED_IO,
    expectedOutputs: DEFAULT_EXPECTED_IO,
    monitor: downloadMonitor(),
  })
  session.destroy()
}

// --- Dispatcher ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // PARSE_HTML — handled synchronously (DOMParser is fast, no queue needed).
  if (message?.type === 'PARSE_HTML') {
    const req = message as ParseRequest
    try {
      const result = req.mode === 'google_search'
        ? parseGoogleSearchResults(req.html)
        : parseGenericPage(req.html)
      Promise.resolve(result)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ markdown: `__PARSE_ERROR__:${(e as Error).message}`, trimmed: false }))
    } catch (e) {
      sendResponse({ markdown: `__PARSE_ERROR__:${(e as Error).message}`, trimmed: false })
    }
    return true
  }

  // All Chrome AI calls — serialized through the FIFO queue.
  if (isChromeAiRequest(message)) {
    withChromeAiLock(() => handleChromeAi(message as ChromeAiRequest))
      .then((result) => sendResponse({ result }))
      .catch((e) => sendResponse({ error: (e as Error).message }))
    return true
  }

  return false
})

function isChromeAiRequest(m: unknown): m is ChromeAiRequest {
  if (!m || typeof m !== 'object') return false
  const t = (m as { type?: string }).type
  return (
    t === 'CHROME_AI_CHAT' ||
    t === 'CHROME_AI_AVAILABILITY' ||
    t === 'CHROME_AI_DOWNLOAD' ||
    t === 'CHROME_AI_SESSION_CREATE' ||
    t === 'CHROME_AI_SESSION_PROMPT' ||
    t === 'CHROME_AI_SESSION_DESTROY'
  )
}

async function handleChromeAi(req: ChromeAiRequest): Promise<unknown> {
  switch (req.type) {
    case 'CHROME_AI_CHAT': return oneShotChatInternal(req)
    case 'CHROME_AI_AVAILABILITY': return getAvailabilityInternal()
    case 'CHROME_AI_DOWNLOAD': return downloadInternal()
    case 'CHROME_AI_SESSION_CREATE': return createSessionInternal(req)
    case 'CHROME_AI_SESSION_PROMPT': return promptSessionInternal(req)
    case 'CHROME_AI_SESSION_DESTROY': destroySessionInternal(req); return null
  }
}
