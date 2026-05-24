import { extractJob, waitForJobPostingPage } from '@/extractor/linkedin'
import { injectScript } from 'wxt/utils/inject-script'

export default defineContentScript({
  matches: ['*://*.linkedin.com/*'],
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

    await injectScript('/spa-tracker.js', { keepInDom: true })
    window.addEventListener('job-bro-url-change', broadcastIfChanged)

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type !== 'EXTRACT_JD') return false
      ;(async () => {
        try {
          const ready = await waitForJobPostingPage(2000)
          if (!ready) {
            sendResponse({
              type: 'JD_EXTRACTION_FAILED',
              error: 'Not a LinkedIn job posting page',
            })
            return
          }
          const job = extractJob()
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
  },
})
