import { extractJobFromPage, waitForJobPage } from '@/extractor/site'
import { injectScript } from 'wxt/utils/inject-script'

export default defineContentScript({
  matches: ['*://*.linkedin.com/*', '*://job-boards.greenhouse.io/*'],
  runAt: 'document_end',
  async main() {
    console.log('[Job Bro] Content script loaded on', location.href)

    let lastUrl = location.href
    const isContextValid = () => !!chrome.runtime?.id

    const broadcastIfChanged = () => {
      if (!isContextValid()) {
        console.warn('[Job Bro] Extension context invalidated. Stopping content script listeners.')
        window.removeEventListener('popstate', broadcastIfChanged)
        window.removeEventListener('job-bro-url-change', broadcastIfChanged)
        return
      }

      if (location.href === lastUrl) return
      lastUrl = location.href
      chrome.runtime.sendMessage({ type: 'URL_CHANGED', url: lastUrl }).catch(() => {})
    }

    window.addEventListener('popstate', broadcastIfChanged)

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type !== 'EXTRACT_JD') return false
      ;(async () => {
        try {
          const ready = await waitForJobPage(2000)
          if (!ready) {
            sendResponse({
              type: 'JD_EXTRACTION_FAILED',
              error: 'Not a supported job posting page',
            })
            return
          }
          const job = extractJobFromPage()
          sendResponse({ type: 'JD_EXTRACTED', payload: job })
        } catch (e) {
          sendResponse({
            type: 'JD_EXTRACTION_FAILED',
            error: (e as Error).message,
          })
        }
      })()
      return true
    })

    // The SPA tracker is only needed on LinkedIn (history.pushState routing that
    // chrome.tabs.onUpdated can miss). Greenhouse boards are multi-page — each
    // job is a full navigation onUpdated already catches — and spa-tracker.js is
    // a web-accessible resource scoped to linkedin.com, so skip it elsewhere.
    if (location.hostname.endsWith('linkedin.com')) {
      try {
        await injectScript('/spa-tracker.js', { keepInDom: true })
        window.addEventListener('job-bro-url-change', broadcastIfChanged)
      } catch (e) {
        console.warn('[Job Bro] Failed to inject SPA tracker:', e)
      }
    }
  },
})
