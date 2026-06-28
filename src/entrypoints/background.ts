import { runChat } from '@/lib/llm-handlers'
import { sendQwenChat } from '@/lib/qwen/qwen-service'
import type { ChatResponse, ExtractionResponse, Message } from '@/types/messages'
import type { AggregatedReport, EvaluatorStatus } from '@/types/evaluation'
import { getSessionByJobId, saveSession, type PersistedEvaluatorProgress } from '@/lib/db'
import { isSupportedJobUrl } from '@/extractor/site'

// Runs on every service-worker startup — confirms which build is live so a
// stale (un-reloaded) worker is immediately obvious in the console.
console.log(`[Job Bro] service worker init — v${__VERSION__}, built ${__BUILD_TIME__}`)

const OFFSCREEN_URL = 'offscreen.html'
const OFFSCREEN_REASONS: chrome.offscreen.Reason[] = [chrome.offscreen.Reason.DOM_PARSER]

// Best-effort broadcast — wrapped so that even if sendMessage itself throws
// (no listeners, port closed), the caller doesn't blow up on the catch path.
function safeBroadcast(message: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(message).catch(() => {})
  } catch {
    /* no listeners or port closed */
  }
}

// Derive the per-evaluator progress map from a completed report. Used when the
// background persists ANALYSIS_COMPLETE — the existing session's `progress`
// snapshot may be stale (it's only persisted on save points, not every
// progress tick), so without this the rehydrated session would show
// pending/running pills against a fully-completed report.
function deriveFinalProgress(report: AggregatedReport): PersistedEvaluatorProgress {
  const statusFor = (s: EvaluatorStatus<unknown>): PersistedEvaluatorProgress[keyof PersistedEvaluatorProgress] => {
    if (s.status === 'fulfilled') return 'completed'
    if (s.status === 'rejected') return 'error'
    return 'blocked'
  }
  const ev = report.evaluators
  const allFulfilled =
    ev.job_fit.status === 'fulfilled' &&
    ev.salary.status === 'fulfilled' &&
    ev.preference.status === 'fulfilled' &&
    ev.risk.status === 'fulfilled' &&
    ev.growth.status === 'fulfilled'
  // Summary lives outside `evaluators` — infer from the report: if any
  // upstream is non-fulfilled, summary was 'blocked'; if all fulfilled and
  // job_summary is set, it ran; otherwise it errored.
  const summary: PersistedEvaluatorProgress[keyof PersistedEvaluatorProgress] = !allFulfilled
    ? 'blocked'
    : (report.job_summary ? 'completed' : 'error')
  return {
    job_fit: statusFor(ev.job_fit),
    salary: statusFor(ev.salary),
    preference: statusFor(ev.preference),
    risk: statusFor(ev.risk),
    growth: statusFor(ev.growth),
    summary,
  }
}

let offscreenReady: Promise<void> | null = null

// Ensure the offscreen document exists. Idempotent — reuses the existing
// document if one is already alive. The offscreen document runs the full
// analysis/resume orchestration (no service worker lifetime limits), the
// htmlparser2 + Turndown work, and Chrome AI sessions.
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

  // Register declarativeNetRequest session rules to spoof Qwen origin/referer
  if (typeof chrome !== 'undefined' && chrome.declarativeNetRequest) {
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders' as unknown as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: [
              { header: 'origin', operation: 'set' as unknown as chrome.declarativeNetRequest.HeaderOperation, value: 'https://chat.qwen.ai' },
              { header: 'referer', operation: 'set' as unknown as chrome.declarativeNetRequest.HeaderOperation, value: 'https://chat.qwen.ai/' }
            ]
          },
          condition: {
            urlFilter: 'https://chat.qwen.ai/api/*',
            resourceTypes: ['xmlhttprequest' as unknown as chrome.declarativeNetRequest.ResourceType],
            initiatorDomains: [chrome.runtime.id]
          }
        }
      ]
    }).then(() => {
      console.log('[Job Bro] Qwen header spoofing net rules registered.');
    }).catch((e) => {
      console.error('[Job Bro] Failed to register Qwen net rules:', e);
    });
  } else {
    console.error('[Job Bro] declarativeNetRequest not supported');
  }

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
    if (message?.type === 'ANALYSIS_COMPLETE') {
      const payload = message.payload
      if (!payload) return false
      const jobId = payload.jobId as string | undefined
      if (jobId) {
        const ok = payload.ok as boolean
        getSessionByJobId(jobId).then((existing) => {
          if (!existing) {
            console.warn('[Job Bro] ANALYSIS_COMPLETE for unknown jobId; skipping IDB persist (sidepanel persistSession should cover this).', jobId)
            return
          }
          if (ok && payload.report) {
            const report = payload.report as AggregatedReport
            const finalProgress = deriveFinalProgress(report)
            saveSession({
              ...existing,
              report,
              progress: finalProgress,
              updatedAt: Date.now(),
              status: 'done',
              error: undefined,
            }).catch((e) => console.error('[Job Bro] Failed to save session on ANALYSIS_COMPLETE:', e))
          } else {
            const error = (payload.error as string | undefined) ?? 'Analysis failed'
            saveSession({
              ...existing,
              updatedAt: Date.now(),
              status: 'error',
              error,
            }).catch((e) => console.error('[Job Bro] Failed to save session on ANALYSIS_COMPLETE:', e))
          }
        }).catch((e) => console.error('[Job Bro] Failed to get session on ANALYSIS_COMPLETE:', e))
      }
    }
    if (message?.type === 'RESUME_COMPLETE' && message.payload?.ok) {
      // Persist when the sidepanel is closed (or missed the broadcast) so the
      // resume isn't lost. jobId now travels with the message, keyed off the
      // ExtractedJob that started the run in the offscreen.
      const jobId = message.payload.jobId as string | undefined
      const markdown = message.payload.markdown as string | undefined
      const summary = message.payload.summary as string | undefined
      if (jobId) {
        getSessionByJobId(jobId).then((existing) => {
          if (existing) {
            saveSession({
              ...existing,
              resumeMarkdown: markdown ?? existing.resumeMarkdown,
              resumeSummary: summary ?? existing.resumeSummary,
              updatedAt: Date.now(),
            }).catch((e) => console.error('[Job Bro] Failed to save session on RESUME_COMPLETE:', e))
          } else {
            console.warn('[Job Bro] RESUME_COMPLETE for unknown jobId; skipping IDB persist.', jobId)
          }
        }).catch((e) => console.error('[Job Bro] Failed to get session on RESUME_COMPLETE:', e))
      }
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

    if (message && (message as { type?: string }).type === 'QWEN_CHAT_REQUEST') {
      const msgs = (message as any).messages;
      sendQwenChat(msgs)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((e) => sendResponse({ ok: false, error: e.message, isAbort: (e as Error).name === 'AbortError' }));
      return true;
    }

    if (message && (message as { type?: string }).type === 'QWEN_PING') {
      sendResponse({ ok: true });
      return false;
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
          chrome.runtime.sendMessage({ ...message, type: 'OFFSCREEN_ANALYZE_JD' }).catch((e) => {
            // Sidepanel is waiting on ANALYSIS_COMPLETE; without a failure
            // broadcast it would hang on the spinner. Same below for resume.
            console.error('[Job Bro] Failed to relay ANALYZE_JD to offscreen:', e)
            safeBroadcast({
              type: 'ANALYSIS_COMPLETE',
              payload: { tabId: message.tabId, jobId: message.payload.job.job_id, ok: false, error: `Relay failed: ${(e as Error).message}` },
            })
          })
        }).catch((e) => {
          console.error('[Job Bro] Failed to ensure offscreen for analysis:', e)
          safeBroadcast({
            type: 'ANALYSIS_COMPLETE',
            payload: { tabId: message.tabId, jobId: message.payload.job.job_id, ok: false, error: `Offscreen unavailable: ${(e as Error).message}` },
          })
        })
        return false

      case 'GENERATE_RESUME':
        ensureOffscreen().then(() => {
          chrome.runtime.sendMessage({ ...message, type: 'OFFSCREEN_GENERATE_RESUME' }).catch((e) => {
            console.error('[Job Bro] Failed to relay GENERATE_RESUME to offscreen:', e)
            safeBroadcast({
              type: 'RESUME_COMPLETE',
              payload: {
                tabId: message.tabId,
                jobId: message.payload.job.job_id,
                ok: false,
                error: `Relay failed: ${(e as Error).message}`,
              },
            })
          })
        }).catch((e) => {
          console.error('[Job Bro] Failed to ensure offscreen for resume:', e)
          safeBroadcast({
            type: 'RESUME_COMPLETE',
            payload: {
              tabId: message.tabId,
              jobId: message.payload.job.job_id,
              ok: false,
              error: `Offscreen unavailable: ${(e as Error).message}`,
            },
          })
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

  if (!tab.url || !isSupportedJobUrl(tab.url)) {
    return {
      type: 'JD_EXTRACTION_FAILED',
      error: 'Not on a supported job posting. Open a LinkedIn or Greenhouse job first.',
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
      error: `Could not inject content script: ${(e as Error).message}. Try refreshing the job tab.`,
    }
  }

  return new Promise<ExtractionResponse>((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_JD' }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({
          type: 'JD_EXTRACTION_FAILED',
          error: 'Still could not connect after injecting. Please refresh the job tab.',
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
