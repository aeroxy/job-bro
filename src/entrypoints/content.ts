import { extractJob, isJobPostingPage } from '@/extractor/linkedin'

export default defineContentScript({
  matches: ['*://www.linkedin.com/jobs/*'],
  runAt: 'document_end',
  main() {
    console.log('[Job Bro] Content script loaded on LinkedIn jobs page')

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'EXTRACT_JD') {
        try {
          if (!isJobPostingPage()) {
            sendResponse({
              type: 'JD_EXTRACTION_FAILED',
              error: 'Not a LinkedIn job posting page',
            })
            return true
          }

          const job = extractJob()
          sendResponse({ type: 'JD_EXTRACTED', payload: job })
        } catch (e) {
          sendResponse({
            type: 'JD_EXTRACTION_FAILED',
            error: (e as Error).message,
          })
        }
      }
      return true
    })
  },
})
