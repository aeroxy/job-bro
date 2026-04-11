import { runResumeGenerator } from '@/evaluators/resume'
import { runAllEvaluators } from '@/evaluators/runner'
import { getCustomPrompt, getLLMConfig, getProfile } from '@/lib/storage'
import type { ExtractionResponse, Message, ResumeResponse } from '@/types/messages'

const analysisControllers = new Map<number, AbortController>()

export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

  // Clean up controllers when tabs are closed
  chrome.tabs.onRemoved.addListener((tabId) => {
    const controller = analysisControllers.get(tabId)
    if (controller) {
      controller.abort()
      analysisControllers.delete(tabId)
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

      case 'GENERATE_RESUME':
        handleGenerateResume(
          message.payload.job,
          message.payload.analysisContext,
          message.payload.previousResume,
          message.payload.previousSummary,
          message.payload.comment
        ).then(sendResponse).catch((e) => {
          sendResponse({ type: 'RESUME_ERROR', error: (e as Error).message })
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
  const profile = await getProfile()
  if (!profile) {
    return { type: 'ANALYSIS_ERROR', error: 'No profile configured. Set up your profile first.' }
  }

  const config = await getLLMConfig()
  if (!config || !config.base_url || !config.model) {
    return { type: 'ANALYSIS_ERROR', error: 'No LLM configured. Set up base URL and model in Settings.' }
  }

  const customPrompt = await getCustomPrompt()

  const onProgress = (evaluator: string, status: 'running' | 'completed' | 'error') => {
    // Broadcast progress to all extension pages (sidebar listens)
    chrome.runtime.sendMessage({
      type: 'ANALYSIS_PROGRESS',
      payload: { tabId, evaluator, status },
    }).catch(() => {
      // Ignore - no listeners
    })
  }

  try {
    const report = await runAllEvaluators(job, profile, config, customPrompt || undefined, onProgress, signal)
    return { type: 'ANALYSIS_RESULT', payload: report }
  } catch (e) {
    return { type: 'ANALYSIS_ERROR', error: (e as Error).message }
  }
}

async function handleGenerateResume(
  job: import('@/types/job').ExtractedJob,
  analysisContext?: string,
  previousResume?: string,
  previousSummary?: string,
  comment?: string
): Promise<ResumeResponse> {
  const profile = await getProfile()
  if (!profile) {
    return { type: 'RESUME_ERROR', error: 'No profile configured. Set up your profile first.' }
  }

  const config = await getLLMConfig()
  if (!config || !config.base_url || !config.model) {
    return { type: 'RESUME_ERROR', error: 'No LLM configured. Set up base URL and model in Settings.' }
  }

  const customPrompt = await getCustomPrompt()

  try {
    const { jobToMarkdown } = await import('@/extractor/markdown')
    const jobMarkdown = jobToMarkdown(job)
    const result = await runResumeGenerator(
      jobMarkdown, profile, config,
      customPrompt || undefined,
      analysisContext, previousResume, previousSummary, comment
    )
    return { type: 'RESUME_RESULT', payload: { markdown: result.resume, summary: result.summary } }
  } catch (e) {
    return { type: 'RESUME_ERROR', error: (e as Error).message }
  }
}
