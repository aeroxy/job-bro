import { extractJob, waitForJobPostingPage } from '@/extractor/linkedin'

export default defineContentScript({
  // Broader matcher: LinkedIn is a SPA, so a /jobs/* only matcher misses cases
  // where the page initially loads on /feed and the user navigates into /jobs.
  // We gate behaviour at message-handling time with waitForJobPostingPage().
  matches: ['*://*.linkedin.com/*'],
  runAt: 'document_end',
  main() {
    console.log('[Job Bro] Content script loaded on', location.href)

    // Broadcast URL changes so the sidepanel can resync. LinkedIn uses a mix of
    // standard navigation and SPA-style pushState transitions. popstate only
    // catches browser-level navigation; we use a polling observer to catch
    // internal SPA transitions.
    let lastUrl = location.href
    const broadcastIfChanged = () => {
      if (location.href === lastUrl) return
      lastUrl = location.href
      chrome.runtime.sendMessage({ type: 'URL_CHANGED', url: lastUrl }).catch(() => {})
    }
    window.addEventListener('popstate', broadcastIfChanged)
    // Detect SPA navigation by polling the URL while the tab is visible. 
    // This is more CPU-efficient than a requestAnimationFrame loop.
    setInterval(() => {
      if (document.visibilityState === 'visible') {
        broadcastIfChanged()
      }
    }, 500)

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type !== 'EXTRACT_JD') return false
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
      return true
    })
  },
})
