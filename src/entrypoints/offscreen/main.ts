// Offscreen document: hosts both the HTML→markdown parser (used by the agent
// tools) and Chrome's built-in AI (Gemini Nano) session — both need a window
// context that the MV3 service worker doesn't have. Lives at
// chrome-extension://<id>/offscreen.html; created eagerly by the background
// service worker via chrome.offscreen.
//
// Concurrency: every Chrome AI call goes through `withChromeAiLock`, a single
// FIFO queue, so concurrent callers (service worker evaluators, sidepanel
// chat, download trigger) all serialize on the one in-process model.

import { parseHtmlToMarkdown } from '@/lib/html-to-markdown'
import type { ChatMessage } from '@/lib/llm-client'
import { runAnalysis, runResume } from '@/lib/llm-handlers'
import type { ProgressCallback, ToolCallCallback, EvaluatorResultCallback } from '@/lib/llm-handlers'
import type { AggregatedReport } from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'
import type { ChatTurn } from '@/types/chat'

type ParseRequest = { type: 'PARSE_HTML'; html: string }

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

// --- Analysis & Resume Orchestration ---
// Runs the full evaluator pipeline in the offscreen document, which has no
// service worker idle/max-lifetime limits. Progress is broadcast to all
// extension pages via chrome.runtime.sendMessage; completion is broadcast
// as ANALYSIS_COMPLETE / RESUME_COMPLETE for the sidepanel to pick up.

const analysisControllers = new Map<number, AbortController>()
const resumeControllers = new Map<number, AbortController>()

function broadcast(message: Record<string, unknown>) {
  try { chrome.runtime.sendMessage(message).catch(() => {}) } catch { /* no listeners */ }
}

async function handleAnalyzeOffscreen(
  tabId: number,
  job: ExtractedJob,
  priorResults?: Partial<AggregatedReport['evaluators']>,
) {
  analysisControllers.get(tabId)?.abort(new DOMException('New analysis started', 'AbortError'))
  const controller = new AbortController()
  analysisControllers.set(tabId, controller)
  const signal = controller.signal

  const onProgress: ProgressCallback = (evaluator, status) => {
    if (signal.aborted) return
    broadcast({ type: 'ANALYSIS_PROGRESS', payload: { tabId, evaluator, kind: 'status', status } })
  }

  const toolSeq = new Map<string, number>()
  const onToolCall: ToolCallCallback = (evaluator, call) => {
    if (signal.aborted) return
    const seq = (toolSeq.get(evaluator) ?? 0) + 1
    toolSeq.set(evaluator, seq)
    let args: Record<string, string> = {}
    try {
      const parsed = JSON.parse(call.function.arguments) as Record<string, unknown>
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') args[k] = v
      }
    } catch { /* malformed args */ }
    const name = call.function.name
    if (name !== 'web_search' && name !== 'read_page') return
    broadcast({ type: 'ANALYSIS_PROGRESS', payload: { tabId, evaluator, kind: 'tool', tool: { name, args, seq } } })
  }

  const onEvaluatorResult: EvaluatorResultCallback = (evaluator, result) => {
    if (signal.aborted) return
    broadcast({ type: 'ANALYSIS_PROGRESS', payload: { tabId, evaluator, kind: 'result', result } })
  }

  try {
    const result = await runAnalysis(job, signal, onProgress, onToolCall, onEvaluatorResult, priorResults)
    // Drop completions from aborted or superseded runs. runAnalysis catches
    // AbortError internally and still returns a (mostly-rejected) report, so
    // without this guard a cancelled run can broadcast a stale ANALYSIS_COMPLETE
    // that overwrites the freshly started run's state in the sidepanel.
    if (signal.aborted || analysisControllers.get(tabId) !== controller) return
    analysisControllers.delete(tabId)
    const ok = result.ok
    broadcast({
      type: 'ANALYSIS_COMPLETE',
      payload: { tabId, ok, ...(ok ? { report: result.report } : { error: result.error }) },
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    if (signal.aborted || analysisControllers.get(tabId) !== controller) return
    analysisControllers.delete(tabId)
    broadcast({ type: 'ANALYSIS_COMPLETE', payload: { tabId, ok: false, error: (e as Error).message } })
  }
}

async function handleResumeOffscreen(
  tabId: number,
  job: ExtractedJob,
  analysisContext?: string,
  previousResume?: string,
  previousSummary?: string,
  comment?: string,
  qnaHistory?: ChatTurn[],
) {
  resumeControllers.get(tabId)?.abort(new DOMException('New resume generation started', 'AbortError'))
  const controller = new AbortController()
  resumeControllers.set(tabId, controller)
  const signal = controller.signal

  try {
    const result = await runResume(job, analysisContext, previousResume, previousSummary, comment, qnaHistory, signal)
    // Drop completions from aborted or superseded runs — see handleAnalyzeOffscreen.
    if (signal.aborted || resumeControllers.get(tabId) !== controller) return
    resumeControllers.delete(tabId)
    const ok = result.ok
    broadcast({
      type: 'RESUME_COMPLETE',
      payload: {
        tabId,
        jobId: job.job_id,
        ok,
        ...(ok ? { markdown: result.markdown, summary: result.summary } : { error: result.error }),
      },
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    if (signal.aborted || resumeControllers.get(tabId) !== controller) return
    resumeControllers.delete(tabId)
    broadcast({ type: 'RESUME_COMPLETE', payload: { tabId, jobId: job.job_id, ok: false, error: (e as Error).message } })
  }
}

// --- Dispatcher ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Analysis orchestration — runs the full evaluator pipeline in the offscreen.
  // Fire-and-forget: results delivered via ANALYSIS_COMPLETE broadcast.
  // Uses OFFSCREEN_ prefix to avoid double-receive (sidepanel broadcasts
  // ANALYZE_JD directly; background relays as OFFSCREEN_ANALYZE_JD).
  if (message?.type === 'OFFSCREEN_ANALYZE_JD') {
    handleAnalyzeOffscreen(message.tabId, message.payload.job, message.payload.priorResults)
    return false
  }

  // Resume orchestration — same pattern.
  if (message?.type === 'OFFSCREEN_GENERATE_RESUME') {
    handleResumeOffscreen(
      message.tabId,
      message.payload.job,
      message.payload.analysisContext,
      message.payload.previousResume,
      message.payload.previousSummary,
      message.payload.comment,
      message.payload.qnaHistory,
    )
    return false
  }

  // Cancellation — abort in-flight offscreen controllers.
  if (message?.type === 'CANCEL_ANALYSIS') {
    analysisControllers.get(message.tabId)?.abort(new DOMException('Cancelled', 'AbortError'))
    analysisControllers.delete(message.tabId)
    return false
  }
  if (message?.type === 'CANCEL_RESUME') {
    resumeControllers.get(message.tabId)?.abort(new DOMException('Cancelled', 'AbortError'))
    resumeControllers.delete(message.tabId)
    return false
  }

  // PARSE_HTML — handled synchronously (DOMParser is fast, no queue needed).
  if (message?.type === 'PARSE_HTML') {
    const req = message as ParseRequest
    try {
      sendResponse(parseHtmlToMarkdown(req.html))
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
