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
    // standard navigation and SPA-style pushState transitions.
    let lastUrl = location.href
    const broadcastIfChanged = () => {
      if (location.href === lastUrl) return
      lastUrl = location.href
      chrome.runtime.sendMessage({ type: 'URL_CHANGED', url: lastUrl }).catch(() => {})
    }

    // 1. Listen for browser-level back/forward navigation
    window.addEventListener('popstate', broadcastIfChanged)

    // 2. Inject a script into the main world to catch SPA-level pushState/replaceState.
    // This is more reactive than polling and handles internal LinkedIn navigation.
    try {
      const script = document.createElement('script')
      script.textContent = `
        (function() {
          const wrap = (type) => {
            const orig = history[type];
            return function() {
              const rv = orig.apply(this, arguments);
              const event = new Event('job-bro-url-change');
              window.dispatchEvent(event);
              return rv;
            };
          };
          history.pushState = wrap('pushState');
          history.replaceState = wrap('replaceState');
        })();
      `
      // Standard injection: head is guaranteed at document_end
      ;(document.head || document.documentElement).appendChild(script)
      script.remove()
      
      // Listen for the custom event dispatched by our main-world wrapper
      window.addEventListener('job-bro-url-change', broadcastIfChanged)
    } catch (e) {
      console.warn('[Job Bro] Failed to inject SPA tracker (likely CSP):', e)
    }

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
