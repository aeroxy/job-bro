// Client for Chrome's built-in AI (Gemini Nano). All actual LanguageModel
// calls live in the offscreen document — this module is a thin messaging
// shim that callers (service worker, sidepanel) use. Concurrency is
// enforced inside the offscreen via a single FIFO queue, so callers don't
// need any locking of their own.

import type { ChatMessage } from './llm-client'

export type ChromeChatOptions = {
  temperature?: number
  json_mode?: boolean
  signal?: AbortSignal
}

// --- One-shot chat completion ---

export async function chatCompletionChrome(
  messages: ChatMessage[],
  options?: ChromeChatOptions
): Promise<string> {
  const res = await sendOrThrow<{ result: string }>({
    type: 'CHROME_AI_CHAT',
    messages,
    temperature: options?.temperature,
    jsonMode: options?.json_mode,
  })
  return res.result
}

// --- Status / availability ---

export async function getChromeAiAvailability(): Promise<ChromeAiAvailability> {
  const res = await sendOrThrow<{ result: ChromeAiAvailability }>({ type: 'CHROME_AI_AVAILABILITY' })
  return res.result
}

export async function ensureChromeAiDownloaded(signal?: AbortSignal): Promise<void> {
  await sendOrThrow<{ result: null }>({ type: 'CHROME_AI_DOWNLOAD', signal: !!signal })
}

// --- Download progress broadcast subscription ---

type DownloadProgressListener = (loaded: number) => void
const progressListeners = new Set<DownloadProgressListener>()

// Wire up the broadcast listener once on first import.
let listenerInstalled = false
function ensureProgressListener() {
  if (listenerInstalled) return
  listenerInstalled = true
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'CHROME_AI_DOWNLOAD_PROGRESS') {
      const loaded = Number(message.loaded)
      if (Number.isFinite(loaded)) progressListeners.forEach((l) => l(loaded))
    }
    return false
  })
}

export function onChromeDownloadProgress(listener: DownloadProgressListener): () => void {
  ensureProgressListener()
  progressListeners.add(listener)
  return () => {
    progressListeners.delete(listener)
  }
}

// --- Persistent session (for the chat hook) ---

export interface SessionOptions {
  systemPrompt: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  temperature?: number
}

export async function createChromeAiSession(opts: SessionOptions): Promise<string> {
  // sendOrThrow wraps the offscreen reply in { result: ... }; the session id
  // lives in `result`, not a top-level `sessionId` (which is always undefined).
  const res = await sendOrThrow<{ result: string }>({
    type: 'CHROME_AI_SESSION_CREATE',
    ...opts,
  })
  return res.result
}

export async function promptChromeAiSession(
  sessionId: string,
  content: string,
  options: { jsonMode?: boolean; signal?: AbortSignal } = {}
): Promise<string> {
  const res = await sendOrThrow<{ result: string }>({
    type: 'CHROME_AI_SESSION_PROMPT',
    sessionId,
    content,
    jsonMode: options.jsonMode,
    signal: !!options.signal,
  })
  return res.result
}

export async function destroyChromeAiSession(sessionId: string): Promise<void> {
  await sendOrThrow<{ result: null }>({
    type: 'CHROME_AI_SESSION_DESTROY',
    sessionId,
  })
}

// --- Helpers ---

type OffscreenResponse<R> = { result?: R; error?: string }

async function sendOrThrow<R>(message: object): Promise<R> {
  const res = (await chrome.runtime.sendMessage(message)) as OffscreenResponse<R> | undefined
  if (!res) throw new Error('Offscreen did not respond to Chrome AI request')
  if (res.error) throw new Error(res.error)
  return { result: res.result } as R
}

// Separator used when folding multiple system messages into a single system
// prompt before sending to the offscreen. Matches the one the offscreen uses
// internally so caller-built prompts and offscreen-built prompts stay
// byte-identical.
export const SYSTEM_PROMPT_SEPARATOR = '\n\n---\n\n'
