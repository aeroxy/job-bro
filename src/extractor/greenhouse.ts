import type { ExtractedJob } from '@/types/job'

// Greenhouse job boards live at job-boards.greenhouse.io/<org>/jobs/<id>. The id
// is namespaced with a `gh:` prefix so it never collides with a (also numeric)
// LinkedIn job_id in the shared `sessions` store. (The legacy boards.greenhouse.io
// host 301-redirects here, so we only need to match job-boards.)
export function extractGreenhouseJobId(url: string): string | null {
  // Restricted to the board host so it never disagrees with isGreenhouseJobUrl
  // (e.g. app.greenhouse.io is not a job board).
  const m = url.match(/job-boards\.greenhouse\.io\/[^/?#]+\/jobs\/(\d+)/)
  return m ? `gh:${m[1]}` : null
}

export function isGreenhouseJobUrl(url: string): boolean {
  // Derived from the id parser so the matcher and extractor never drift apart.
  return extractGreenhouseJobId(url) !== null
}

// Readiness gates on the description specifically: the title (h1.section-header)
// can mount before the body, and extracting then would persist an empty
// description. Requiring .job__description guarantees the content we need exists.
const READY_SELECTOR = '.job__description'

// Greenhouse boards are server-rendered, but the content can still mount a beat
// after document_end. Poll for the description to appear before extracting.
export async function waitForGreenhousePage(timeoutMs = 2000): Promise<boolean> {
  if (!isGreenhouseJobUrl(window.location.href)) return false
  if (document.querySelector(READY_SELECTOR)) return true

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
      if (document.querySelector(READY_SELECTOR)) finish(true)
    })
    observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })

    const timer = setTimeout(() => finish(false), timeoutMs)
  })
}

function extractCompany(): string {
  // document.title is "Job Application for <title> at <Company>". Use the LAST
  // " at " so a job title that itself contains " at " doesn't break parsing.
  const idx = document.title.lastIndexOf(' at ')
  if (idx !== -1) {
    const company = document.title.slice(idx + 4).trim()
    if (company) return company
  }
  // Fallback: the org slug in the URL path (job-boards.greenhouse.io/<org>/jobs/).
  // Slugs are hyphen/underscore separated, so title-case each word
  // (e.g. "digital-ocean" → "Digital Ocean").
  const slug = window.location.href.match(/greenhouse\.io\/([^/?#]+)\/jobs\//)?.[1]
  if (slug) return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return 'Unknown'
}

export function extractGreenhouseJob(): ExtractedJob {
  if (!isGreenhouseJobUrl(window.location.href)) {
    throw new Error('Not a Greenhouse job posting page')
  }

  const title =
    document.querySelector('h1.section-header')?.textContent?.trim() ||
    document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
    ''
  const location = document.querySelector('.job__location')?.textContent?.trim() ?? ''
  const descEl = document.querySelector<HTMLElement>('.job__description')
  const description = descEl?.innerText?.trim() || descEl?.textContent?.trim() || ''

  if (!description) {
    throw new Error('Could not extract job content — page may still be loading')
  }

  return {
    job_id: extractGreenhouseJobId(window.location.href) ?? undefined,
    url: window.location.href,
    extracted_at: Date.now(),
    title: title || document.title,
    company: extractCompany(),
    location,
    description,
  }
}
