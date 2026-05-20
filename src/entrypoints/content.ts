import { extractJob, waitForJobPostingPage } from '@/extractor/linkedin'

export default defineContentScript({
  // Broader matcher: LinkedIn is a SPA, so a /jobs/* only matcher misses cases
  // where the page initially loads on /feed and the user navigates into /jobs.
  // We gate behaviour at message-handling time with waitForJobPostingPage().
  matches: ['*://*.linkedin.com/*'],
  runAt: 'document_end',
  main() {
    console.log('[Job Bro] Content script loaded on', location.href)

    // Broadcast URL changes from LinkedIn's SPA navigation (history.pushState /
    // replaceState / popstate) so the sidepanel can resync. chrome.tabs.onUpdated
    // does fire for pushState in most cases, but this is defence-in-depth — the
    // panel listens for both.
    let lastUrl = location.href
    const broadcastIfChanged = () => {
      if (location.href === lastUrl) return
      lastUrl = location.href
      chrome.runtime.sendMessage({ type: 'URL_CHANGED', url: lastUrl }).catch(() => {})
    }

    const origPush = history.pushState
    history.pushState = function (...args) {
      const result = origPush.apply(this, args)
      queueMicrotask(broadcastIfChanged)
      return result
    }
    const origReplace = history.replaceState
    history.replaceState = function (...args) {
      const result = origReplace.apply(this, args)
      queueMicrotask(broadcastIfChanged)
      return result
    }
    window.addEventListener('popstate', broadcastIfChanged)

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'EXTRACT_JD') {
        // Poll for the job detail container — LinkedIn renders it lazily after
        // route transitions, so a synchronous check would falsely report "not a
        // LinkedIn job posting page" for the first few hundred ms after navigation.
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
        return true // async response
      }
      return true
    })
  },
})
