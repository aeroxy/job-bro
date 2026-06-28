import type { ExtractedJob } from '@/types/job'

export function extractLinkedInJobId(url: string): string | null {
  // /jobs/view/ URLs come in two shapes: a bare numeric id
  // (/jobs/view/4417162348/) and a slug with the id trailing
  // (/jobs/view/ai-systems-engineer-at-openai-4417162348/). The optional
  // `[^/?#]*-` prefix skips the slug so the trailing digits are captured in
  // both cases. Falls back to the currentJobId query param on search/collections.
  const m =
    url.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d+)/) ??
    url.match(/[?&]currentJobId=(\d+)/)
  return m?.[1] ?? null
}

// /jobs/view/ renders the job in [data-testid="lazy-column"]; the search and
// collections panes render it in .job-details-jobs-unified-top-card__*. Either
// selector signals the job content has mounted.
const JOB_CONTENT_SELECTOR =
  '[data-testid="lazy-column"], .job-details-jobs-unified-top-card__job-title'

function isJobPostingPage(): boolean {
  const url = window.location.href
  const isJobUrl = /linkedin\.com\/jobs\/(view|collections|search)\//.test(url)
  return isJobUrl && !!document.querySelector(JOB_CONTENT_SELECTOR)
}

// Async variant: polls for the job content container to render. LinkedIn renders
// the job detail lazily after route transitions, so a single synchronous check
// fails for a few hundred ms after navigation. Used by the content script when
// responding to EXTRACT_JD.
export async function waitForJobPostingPage(timeoutMs = 2000): Promise<boolean> {
  const url = window.location.href
  const isJobUrl = /linkedin\.com\/jobs\/(view|collections|search)\//.test(url)
  if (!isJobUrl) return false

  if (document.querySelector(JOB_CONTENT_SELECTOR)) return true

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      observer.disconnect()
      clearTimeout(timer)
      resolve(result)
    }

    const observer = new MutationObserver(() => {
      if (document.querySelector(JOB_CONTENT_SELECTOR)) finish(true)
    })
    observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })

    const timer = setTimeout(() => finish(false), timeoutMs)
  })
}

function extractFromLazyColumn(lazyCol: Element): { title: string; company: string; location: string } {
  // LinkedIn's current structure (as of 2025):
  // p[0] = company name
  // p[1] = job title
  // p[2] = "Location · time ago · N people applied"
  const ps = [...lazyCol.querySelectorAll('p')]
    .filter((p) => p.textContent?.trim())

  const company = ps[0]?.textContent?.trim() ?? ''
  const title = ps[1]?.textContent?.trim() ?? ''
  const locationRaw = ps[2]?.textContent?.trim() ?? ''
  const location = locationRaw.split('·')[0].trim()

  return { title, company, location }
}

function extractFromUnifiedTopCard(): { title: string; company: string; location: string } {
  // Search / collections detail pane (no lazy-column): a unified "top card".
  const title =
    document.querySelector('.job-details-jobs-unified-top-card__job-title')?.textContent?.trim() ?? ''
  const company =
    document.querySelector('.job-details-jobs-unified-top-card__company-name')?.textContent?.trim() ?? ''
  const primary =
    document.querySelector('.job-details-jobs-unified-top-card__primary-description-container')?.textContent?.trim() ?? ''
  const location = primary.split('·')[0].trim()

  return { title, company, location }
}

function extractDescription(): string {
  // Search / collections panes render the full body in #job-details.
  const details =
    document.querySelector('#job-details, .jobs-description__content')?.textContent?.trim() ?? ''
  if (details.length > 100) return details

  // /jobs/view/ uses a different structure — walk from the "About the job"
  // heading to the first substantial sibling.
  const aboutH2 = [...document.querySelectorAll('h2')]
    .find((h) => h.textContent?.trim() === 'About the job')
  if (!aboutH2) return details

  let container: Element | null = aboutH2.parentElement
  while (container) {
    const sibling = container.nextElementSibling
    if (sibling && (sibling.textContent?.trim().length ?? 0) > 100) {
      return sibling.textContent?.trim() ?? ''
    }
    container = container.parentElement
  }

  return details
}

export function extractJob(): ExtractedJob {
  if (!isJobPostingPage()) {
    throw new Error('Not a LinkedIn job posting page')
  }

  const lazyCol = document.querySelector('[data-testid="lazy-column"]')
  const { title, company, location } = lazyCol
    ? extractFromLazyColumn(lazyCol)
    : extractFromUnifiedTopCard()
  const description = extractDescription()

  if (!title && !description) {
    throw new Error('Could not extract job content — page may still be loading')
  }

  return {
    job_id: extractLinkedInJobId(window.location.href) ?? undefined,
    url: window.location.href,
    extracted_at: Date.now(),
    title: title || document.title.split('|')[0].trim(),
    company: company || document.title.split('|')[1]?.trim() || 'Unknown',
    location,
    description,
  }
}
