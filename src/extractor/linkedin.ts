import type { ExtractedJob } from '@/types/job'

export function extractLinkedInJobId(url: string): string | null {
  const m = url.match(/\/jobs\/view\/(\d+)/) ?? url.match(/[?&]currentJobId=(\d+)/)
  return m?.[1] ?? null
}

function isJobPostingPage(lazyCol?: Element | null): boolean {
  const url = window.location.href
  const isJobUrl = /linkedin\.com\/jobs\/(view|collections|search)\//.test(url)
  const hasJobContent = lazyCol !== undefined ? !!lazyCol : !!document.querySelector('[data-testid="lazy-column"]')
  return isJobUrl && hasJobContent
}

// Async variant: polls for the lazy-column container to render. LinkedIn renders
// the job detail column lazily after route transitions, so a single synchronous
// check fails for a few hundred ms after navigation. Used by the content script
// when responding to EXTRACT_JD.
export async function waitForJobPostingPage(timeoutMs = 2000): Promise<boolean> {
  const url = window.location.href
  const isJobUrl = /linkedin\.com\/jobs\/(view|collections|search)\//.test(url)
  if (!isJobUrl) return false

  if (document.querySelector('[data-testid="lazy-column"]')) return true

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
      if (document.querySelector('[data-testid="lazy-column"]')) finish(true)
    })
    observer.observe(document.body, { childList: true, subtree: true })

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

function extractDescription(): string {
  const aboutH2 = [...document.querySelectorAll('h2')]
    .find((h) => h.textContent?.trim() === 'About the job')

  if (!aboutH2) return ''

  // Walk up until we find a sibling element that contains the description
  let container: Element | null = aboutH2.parentElement
  while (container) {
    const sibling = container.nextElementSibling
    if (sibling && (sibling.textContent?.trim().length ?? 0) > 100) {
      return sibling.textContent?.trim() ?? ''
    }
    container = container.parentElement
  }

  return ''
}

export function extractJob(): ExtractedJob {
  const lazyCol = document.querySelector('[data-testid="lazy-column"]')
  if (!isJobPostingPage(lazyCol) || !lazyCol) {
    throw new Error('Not a LinkedIn job posting page')
  }

  const { title, company, location } = extractFromLazyColumn(lazyCol)
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
