import { runChat } from '@/lib/llm-handlers'
import type { ChatResponse, ExtractionResponse, Message } from '@/types/messages'
import type { AggregatedReport } from '@/types/evaluation'
import { getSessionByJobId, saveSession } from '@/lib/db'

// Runs on every service-worker startup — confirms which build is live so a
// stale (un-reloaded) worker is immediately obvious in the console.
console.log(`[Job Bro] service worker init — v${__VERSION__}, built ${__BUILD_TIME__}`)

const OFFSCREEN_URL = 'offscreen.html'
const OFFSCREEN_REASONS: chrome.offscreen.Reason[] = [chrome.offscreen.Reason.DOM_PARSER]

let offscreenReady: Promise<void> | null = null

// Ensure the offscreen document exists. Idempotent — reuses the existing
// document if one is already alive. The offscreen document runs the full
// analysis/resume orchestration (no service worker lifetime limits), the
// DOMParser + Turndown work, and Chrome AI sessions.
async function ensureOffscreen(): Promise<void> {
  if (offscreenReady) {
    try { await offscreenReady } catch { offscreenReady = null }
  }
  if (await hasOffscreenDocument()) return
  offscreenReady = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: OFFSCREEN_REASONS,
        justification: 'Parse fetched HTML into markdown and run LLM orchestration for the agent tools.',
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('Only a single offscreen document')) return
      throw e
    }
  })().catch((e) => {
    offscreenReady = null
    throw e
  })
  return offscreenReady
}

async function hasOffscreenDocument(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    })
    return contexts.length > 0
  } catch {
    return false
  }
}

/**
 * Background service worker for the Job Bro extension.
 * Relays analysis/resume orchestration to the offscreen document (which has
 * no service worker lifetime limits), handles extraction and chat directly,
 * and persists results to IndexedDB on completion broadcasts.
 */
export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

  ensureOffscreen().catch((e) => console.warn('[Job Bro] Offscreen create failed', e))

  chrome.runtime.onInstalled.addListener((details) => {
    console.log('[Job Bro] Extension installed or updated:', details.reason)
  })

  // When tabs are closed, forward cancellation to the offscreen so it can
  // abort any in-flight analysis/resume controllers for that tab.
  chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.runtime.sendMessage({ type: 'CANCEL_ANALYSIS', tabId }).catch(() => {})
    chrome.runtime.sendMessage({ type: 'CANCEL_RESUME', tabId }).catch(() => {})
  })

  // Persist results to IDB when the offscreen broadcasts completion events.
  chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    if (message?.type === 'ANALYSIS_COMPLETE' && message.payload?.ok && message.payload.report) {
      const jobId = message.payload.report.job_id as string | undefined
      if (jobId) {
        getSessionByJobId(jobId).then((existing) => {
          if (existing) {
            saveSession({
              ...existing,
              report: message.payload.report as AggregatedReport,
              updatedAt: Date.now(),
              status: 'done',
            }).catch(() => {})
          } else {
            console.warn('[Job Bro] ANALYSIS_COMPLETE for unknown jobId; skipping IDB persist (sidepanel persistSession should cover this).', jobId)
          }
        }).catch(() => {})
      }
    }
    if (message?.type === 'RESUME_COMPLETE' && message.payload?.ok) {
      // Resume persistence is handled by the sidepanel's persistSession on
      // receiving RESUME_COMPLETE. The background doesn't persist resume here
      // because the completion message doesn't include jobId.
    }
    return false
  })

  chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
    // Storage bridge: the offscreen document doesn't have chrome.storage
    // access, so it routes reads/writes through the background.
    if (message && (message as { type?: string }).type === 'GET_STORAGE') {
      const key = (message as unknown as { key: string }).key
      chrome.storage.local.get(key).then(sendResponse).catch(() => {
        sendResponse({})
      })
      return true
    }
    if (message && (message as { type?: string }).type === 'SET_STORAGE') {
      const items = (message as unknown as { items: Record<string, unknown> }).items
      chrome.storage.local.set(items).then(() => sendResponse(undefined)).catch(() => {
        sendResponse(undefined)
      })
      return true
    }

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

      // Analysis and resume are relayed to the offscreen document, which runs
      // the full pipeline without service worker lifetime limits. The offscreen
      // broadcasts ANALYSIS_COMPLETE / RESUME_COMPLETE when done.
      // IMPORTANT: transform the message type so the offscreen only processes
      // the background's relay, not the sidepanel's direct broadcast. Without
      // this, the offscreen receives the message twice, aborting the first
      // run and restarting.
      case 'ANALYZE_JD':
        ensureOffscreen().then(() => {
          chrome.runtime.sendMessage({ ...message, type: 'OFFSCREEN_ANALYZE_JD' }).catch(() => {})
        }).catch((e) => {
          console.error('[Job Bro] Failed to ensure offscreen for analysis:', e)
        })
        return false

      case 'GENERATE_RESUME':
        ensureOffscreen().then(() => {
          chrome.runtime.sendMessage({ ...message, type: 'OFFSCREEN_GENERATE_RESUME' }).catch(() => {})
        }).catch((e) => {
          console.error('[Job Bro] Failed to ensure offscreen for resume:', e)
        })
        return false

      // Cancellation: the offscreen also receives CANCEL_ANALYSIS/CANCEL_RESUME
      // directly via broadcast from the sidepanel. No relay needed here — the
      // background has no controllers to clean up anymore.
      case 'CANCEL_ANALYSIS':
      case 'CANCEL_RESUME':
        return false

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
        // Handle DDG bot challenge tab opening (forwarded from offscreen where
        // chrome.tabs may be unavailable).
        if ((message as { type?: string }).type === 'OPEN_DDGC_CHALLENGE_TAB') {
          const url = (message as { url?: string }).url
          if (url) {
            chrome.tabs.query({ url: 'https://html.duckduckgo.com/*' }).then((existing) => {
              const tabId = existing[0]?.id
              if (tabId != null) {
                chrome.tabs.update(tabId, { active: true, url })
              } else {
                chrome.tabs.create({ url, active: true })
              }
            }).catch(() => {})
          }
          return false
        }
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
  const response = await new Promise<ExtractionResponse | null>((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_JD' }, (res) => {
      if (chrome.runtime.lastError) {
        resolve(null)
      } else {
        resolve(res as ExtractionResponse)
      }
    })
  })

  if (response) return response

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
