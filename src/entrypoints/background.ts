import { runAllEvaluators } from '@/evaluators/runner'
import { getCustomPrompt, getLLMConfig, getProfile } from '@/lib/storage'
import type { ExtractionResponse, Message } from '@/types/messages'

export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

  chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
    switch (message.type) {
      case 'REQUEST_EXTRACTION':
        handleRequestExtraction().then(sendResponse).catch((e) => {
          sendResponse({ type: 'JD_EXTRACTION_FAILED', error: (e as Error).message })
        })
        return true

      case 'ANALYZE_JD':
        handleAnalyzeJD(message.payload.job).then(sendResponse).catch((e) => {
          sendResponse({ type: 'ANALYSIS_ERROR', error: (e as Error).message })
        })
        return true

      default:
        return false
    }
  })
})

async function handleRequestExtraction(): Promise<ExtractionResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })

  if (!tab?.id) {
    return { type: 'JD_EXTRACTION_FAILED', error: 'No active tab found' }
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

async function handleAnalyzeJD(job: import('@/types/job').ExtractedJob) {
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
      payload: { evaluator, status },
    }).catch(() => {
      // Ignore - no listeners
    })
  }

  try {
    const report = await runAllEvaluators(job, profile, config, customPrompt || undefined, onProgress)
    return { type: 'ANALYSIS_RESULT', payload: report }
  } catch (e) {
    return { type: 'ANALYSIS_ERROR', error: (e as Error).message }
  }
}
