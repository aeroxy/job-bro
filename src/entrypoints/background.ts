import { runAnalysis, runChat, runResume } from '@/lib/llm-handlers'
import type { ChatResponse, ExtractionResponse, Message, ResumeResponse } from '@/types/messages'

const analysisControllers = new Map<number, AbortController>()
const resumeControllers = new Map<number, AbortController>()

export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

  chrome.runtime.onInstalled.addListener((details) => {
    console.log('[Job Bro] Extension installed or updated:', details.reason)
    if (details.reason === 'update' || details.reason === 'install') {
      // Optional: Logic to re-inject scripts into open tabs could go here
    }
  })

  // Clean up controllers when tabs are closed
  chrome.tabs.onRemoved.addListener((tabId) => {
    const controller = analysisControllers.get(tabId)
    if (controller) {
      controller.abort()
      analysisControllers.delete(tabId)
    }
    const resumeController = resumeControllers.get(tabId)
    if (resumeController) {
      resumeController.abort()
      resumeControllers.delete(tabId)
    }
  })

  chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
    switch (message.type) {
      case 'REQUEST_EXTRACTION':
        handleRequestExtraction(message.tabId).then(sendResponse).catch((e) => {
          sendResponse({ type: 'JD_EXTRACTION_FAILED', error: (e as Error).message })
        })
        return true

      case 'CANCEL_ANALYSIS': {
        const controller = analysisControllers.get(message.tabId)
        if (controller) {
          controller.abort()
          analysisControllers.delete(message.tabId)
        }
        const resumeCtrl = resumeControllers.get(message.tabId)
        if (resumeCtrl) {
          resumeCtrl.abort()
          resumeControllers.delete(message.tabId)
        }
        return false
      }

      case 'ANALYZE_JD': {
        const tabId = message.tabId
        // Abort any existing analysis for this tab
        const existing = analysisControllers.get(tabId)
        if (existing) {
          existing.abort()
        }
        const controller = new AbortController()
        analysisControllers.set(tabId, controller)
        handleAnalyzeJD(message.payload.job, controller.signal, tabId).then((result) => {
          analysisControllers.delete(tabId)
          sendResponse(result)
        }).catch((e) => {
          analysisControllers.delete(tabId)
          sendResponse({ type: 'ANALYSIS_ERROR', error: (e as Error).message })
        })
        return true
      }

      case 'GENERATE_RESUME': {
        const tabId = message.tabId
        const existingResume = resumeControllers.get(tabId)
        if (existingResume) {
          existingResume.abort()
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
          resumeControllers.delete(tabId)
          sendResponse(result)
        }).catch((e) => {
          resumeControllers.delete(tabId)
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

async function handleAnalyzeJD(job: import('@/types/job').ExtractedJob, signal: AbortSignal, tabId: number) {
  const onProgress = (evaluator: string, status: 'running' | 'completed' | 'error') => {
    chrome.runtime.sendMessage({
      type: 'ANALYSIS_PROGRESS',
      payload: { tabId, evaluator, status },
    }).catch(() => { /* no listeners */ })
  }

  const result = await runAnalysis(job, signal, onProgress)
  if (result.ok) return { type: 'ANALYSIS_RESULT', payload: result.report }
  return { type: 'ANALYSIS_ERROR', error: result.error }
}

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
