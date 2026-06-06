import { runAnalysis, runChat, runResume } from '@/lib/llm-handlers'
import type { EvaluatorResultCallback, ToolCallCallback } from '@/lib/llm-handlers'
import type { ChatResponse, ExtractionResponse, Message, ResumeResponse } from '@/types/messages'

const analysisControllers = new Map<number, AbortController>()
const resumeControllers = new Map<number, AbortController>()

const OFFSCREEN_URL = 'offscreen.html'
const OFFSCREEN_REASONS: chrome.offscreen.Reason[] = [chrome.offscreen.Reason.DOM_PARSER]

let offscreenReady: Promise<void> | null = null

// Ensure the offscreen document exists. Idempotent — reuses the existing
// document if one is already alive. The offscreen document runs the
// DOMParser + Turndown work; the service worker only does fetch + routing.
// Service-worker-only: chrome.offscreen.createDocument is unavailable from
// extension pages.
async function ensureOffscreen(): Promise<void> {
  if (offscreenReady) return offscreenReady
  offscreenReady = (async () => {
    try {
      // @ts-expect-error — hasDocument() exists at runtime but isn't in the typings
      if (await chrome.offscreen.hasDocument?.(OFFSCREEN_URL)) return
    } catch {
      /* hasDocument not available — fall through to createDocument */
    }
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: OFFSCREEN_REASONS,
      justification: 'Parse fetched HTML into markdown for the agent tools.',
    })
  })().catch((e) => {
    offscreenReady = null
    throw e
  })
  return offscreenReady
}

/**
 * Background service worker for the Job Bro extension.
 * Orchestrates job extraction, analysis, and resume generation by coordinating
 * between the content scripts and the LLM handlers.
 */
export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

  // Eagerly create the offscreen document so the agent tools are ready by the
  // time an analysis is requested. Service workers can be killed and restarted
  // — ensureOffscreen is idempotent and re-creates the document if the system
  // closed it.
  ensureOffscreen().catch((e) => console.warn('[Job Bro] Offscreen create failed', e))

  chrome.runtime.onInstalled.addListener((details) => {
    console.log('[Job Bro] Extension installed or updated:', details.reason)
  })

  // Clean up controllers when tabs are closed
  chrome.tabs.onRemoved.addListener((tabId) => {
    const controller = analysisControllers.get(tabId)
    if (controller) {
      controller.abort(new DOMException('Tab was closed', 'AbortError'))
      analysisControllers.delete(tabId)
    }
    const resumeController = resumeControllers.get(tabId)
    if (resumeController) {
      resumeController.abort(new DOMException('Tab was closed', 'AbortError'))
      resumeControllers.delete(tabId)
    }
  })

  chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
    // The offscreen document handles PARSE_HTML. Returning false here means
    // "don't claim the response" so the offscreen's listener can call
    // sendResponse and the caller's sendMessage awaits it.
    if (message && (message as { type?: string }).type === 'PARSE_HTML') {
      return false
    }

    switch (message.type) {
      case 'REQUEST_EXTRACTION':
        handleRequestExtraction(message.tabId).then(sendResponse).catch((e) => {
          sendResponse({ type: 'JD_EXTRACTION_FAILED', error: (e as Error).message })
        })
        return true

      case 'CANCEL_ANALYSIS': {
        const controller = analysisControllers.get(message.tabId)
        if (controller) {
          controller.abort(new DOMException('User stopped analysis', 'AbortError'))
          analysisControllers.delete(message.tabId)
        }
        return false
      }

      case 'CANCEL_RESUME': {
        const resumeCtrl = resumeControllers.get(message.tabId)
        if (resumeCtrl) {
          resumeCtrl.abort(new DOMException('User stopped resume generation', 'AbortError'))
          resumeControllers.delete(message.tabId)
        }
        return false
      }

      case 'ANALYZE_JD': {
        const tabId = message.tabId
        const existing = analysisControllers.get(tabId)
        if (existing) {
          existing.abort(new DOMException('New analysis started', 'AbortError'))
        }
        const controller = new AbortController()
        analysisControllers.set(tabId, controller)
        handleAnalyzeJD(message.payload.job, controller.signal, tabId).then((result) => {
          if (analysisControllers.get(tabId) === controller) {
            analysisControllers.delete(tabId)
          }
          sendResponse(result)
        }).catch((e) => {
          if (analysisControllers.get(tabId) === controller) {
            analysisControllers.delete(tabId)
          }
          sendResponse({ type: 'ANALYSIS_ERROR', error: (e as Error).message })
        })
        return true
      }

      case 'GENERATE_RESUME': {
        const tabId = message.tabId
        const existingResume = resumeControllers.get(tabId)
        if (existingResume) {
          existingResume.abort(new DOMException('New resume generation started', 'AbortError'))
        }
        const controller = new AbortController()
        resumeControllers.set(tabId, controller)
        handleGenerateResume(
          message.payload.job,
          controller.signal,
          message.payload.analysisContext,
          message.payload.previousResume,
          message.payload.previousSummary,
          message.payload.comment,
          message.payload.qnaHistory
        ).then((result) => {
          if (resumeControllers.get(tabId) === controller) {
            resumeControllers.delete(tabId)
          }
          sendResponse(result)
        }).catch((e) => {
          if (resumeControllers.get(tabId) === controller) {
            resumeControllers.delete(tabId)
          }
          sendResponse({ type: 'RESUME_ERROR', error: (e as Error).message })
        })
        return true
      }

      case 'CHAT_REQUEST':
        handleChatMessage(
          message.payload.question,
          message.payload.history,
          message.payload.jobMarkdown,
          message.payload.analysisContext
        ).then(sendResponse).catch((e) => {
          sendResponse({ type: 'CHAT_ERROR', error: (e as Error).message })
        })
        return true

      default:
        return false
    }
  })
})

/**
 * Validates the tab state and requests job description extraction from the content script.
 * @param tabId - The ID of the tab to extract from.
 * @returns A promise resolving to the extraction response.
 */
async function handleRequestExtraction(tabId: number): Promise<ExtractionResponse> {
  const tab = await chrome.tabs.get(tabId).catch(() => null)

  if (!tab) {
    return { type: 'JD_EXTRACTION_FAILED', error: 'Tab not found' }
  }

  if (!tab.url?.includes('linkedin.com/jobs')) {
    return {
      type: 'JD_EXTRACTION_FAILED',
      error: 'Not on a LinkedIn jobs page. Navigate to a job posting first.',
    }
  }

  return sendExtractMessage(tab.id!)
}

/**
 * Sends an extraction message to the content script, attempting to re-inject
 * the script if the first attempt fails.
 * @param tabId - The ID of the tab to send the message to.
 * @returns A promise resolving to the extraction response.
 */
async function sendExtractMessage(tabId: number): Promise<ExtractionResponse> {
  // First attempt: message the already-running content script
  const response = await new Promise<ExtractionResponse | null>((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_JD' }, (res) => {
      if (chrome.runtime.lastError) {
        resolve(null) // content script not running
      } else {
        resolve(res as ExtractionResponse)
      }
    })
  })

  if (response) return response

  // Content script not running (tab was open before extension loaded).
  // Inject it programmatically, then retry.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/content.js'],
    })
  } catch (e) {
    return {
      type: 'JD_EXTRACTION_FAILED',
      error: `Could not inject content script: ${(e as Error).message}. Try refreshing the LinkedIn tab.`,
    }
  }

  // Retry after injection
  return new Promise<ExtractionResponse>((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_JD' }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({
          type: 'JD_EXTRACTION_FAILED',
          error: 'Still could not connect after injecting. Please refresh the LinkedIn tab.',
        })
      } else {
        resolve(res as ExtractionResponse)
      }
    })
  })
}

/**
 * Orchestrates job analysis by calling runAnalysis and broadcasting progress updates.
 * @param job - The extracted job description.
 * @param signal - AbortSignal for cancellation.
 * @param tabId - The initiator tab ID.
 * @returns A promise resolving to the analysis result message.
 */
async function handleAnalyzeJD(job: import('@/types/job').ExtractedJob, signal: AbortSignal, tabId: number) {
  // Make sure the offscreen parser is alive before evaluators may try to
  // call web_search / read_page.
  await ensureOffscreen()

  const onProgress = (evaluator: string, status: 'running' | 'completed' | 'error') => {
    chrome.runtime.sendMessage({
      type: 'ANALYSIS_PROGRESS',
      payload: { tabId, evaluator, kind: 'status', status },
    }).catch(() => { /* no listeners */ })
  }

  // Per-evaluator monotonic counter — lets the sidepanel dedupe / supersede
  // in-flight tool activity (the latest "Searching X" replaces the previous one
  // for the same evaluator's display row).
  const toolSeqRef = { current: new Map<string, number>() }
  const onToolCall: ToolCallCallback = (evaluator, call) => {
    const seq = (toolSeqRef.current.get(evaluator) ?? 0) + 1
    toolSeqRef.current.set(evaluator, seq)
    let args: Record<string, string> = {}
    try {
      const parsed = JSON.parse(call.function.arguments) as Record<string, unknown>
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') args[k] = v
      }
    } catch {
      /* malformed args — fall through with empty args */
    }
    const name = call.function.name
    if (name !== 'web_search' && name !== 'read_page') return
    chrome.runtime.sendMessage({
      type: 'ANALYSIS_PROGRESS',
      payload: { tabId, evaluator, kind: 'tool', tool: { name, args, seq } },
    }).catch(() => { /* no listeners */ })
  }

  // Stream each evaluator's result as soon as it lands so the sidepanel can
  // render that card's body immediately, not after the aggregator has
  // bundled all of them. See AnalysisProgressMessage `kind: 'result'`.
  const onEvaluatorResult: EvaluatorResultCallback = (evaluator, result) => {
    chrome.runtime.sendMessage({
      type: 'ANALYSIS_PROGRESS',
      payload: { tabId, evaluator, kind: 'result', result },
    }).catch(() => { /* no listeners */ })
  }

  const result = await runAnalysis(job, signal, onProgress, onToolCall, onEvaluatorResult)
  if (result.ok) return { type: 'ANALYSIS_RESULT', payload: result.report }
  return { type: 'ANALYSIS_ERROR', error: result.error }
}

/**
 * Handles interactive chat messages about a specific job posting.
 * @param question - The user's question.
 * @param history - Prior conversation turns.
 * @param jobMarkdown - The job description in markdown format.
 * @param analysisContext - The completed analysis report.
 * @returns A promise resolving to the chat response message.
 */
async function handleChatMessage(
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  jobMarkdown: string,
  analysisContext: string
): Promise<ChatResponse> {
  const result = await runChat(question, history, jobMarkdown, analysisContext)
  if (result.ok) return { type: 'CHAT_RESPONSE', payload: { answer: result.answer } }
  return { type: 'CHAT_ERROR', error: result.error }
}

/**
 * Orchestrates resume generation based on a job posting and analysis.
 * @param job - The extracted job description.
 * @param signal - AbortSignal for cancellation.
 * @param analysisContext - Optional analysis report.
 * @param previousResume - Optional prior resume version.
 * @param previousSummary - Optional prior summary version.
 * @param comment - Optional user feedback for regeneration.
 * @param qnaHistory - Optional chat history for context.
 * @returns A promise resolving to the resume response message.
 */
async function handleGenerateResume(
  job: import('@/types/job').ExtractedJob,
  signal: AbortSignal,
  analysisContext?: string,
  previousResume?: string,
  previousSummary?: string,
  comment?: string,
  qnaHistory?: import('@/types/chat').ChatTurn[]
): Promise<ResumeResponse> {
  const result = await runResume(job, analysisContext, previousResume, previousSummary, comment, qnaHistory, signal)
  if (result.ok) return { type: 'RESUME_RESULT', payload: { markdown: result.markdown, summary: result.summary } }
  return { type: 'RESUME_ERROR', error: result.error }
}
