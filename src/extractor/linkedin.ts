import type { ExtractedJob } from '@/types/job'

export function isJobPostingPage(): boolean {
  const url = window.location.href
  const isJobUrl = /linkedin\.com\/jobs\/(view|collections|search)\//.test(url)
  // LinkedIn now uses data-testid="lazy-column" as the main job detail container
  const hasJobContent = !!document.querySelector('[data-testid="lazy-column"]')
  return isJobUrl && hasJobContent
}

function extractFromLazyColumn(): { title: string; company: string; location: string } {
  const lazyCol = document.querySelector('[data-testid="lazy-column"]')
  if (!lazyCol) return { title: '', company: '', location: '' }

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

function extractSalary(): string | undefined {
  // LinkedIn sometimes shows salary in specific elements
  const allText = [...document.querySelectorAll('*')]
    .filter((el) => el.children.length === 0)
    .map((el) => el.textContent?.trim() ?? '')
    .find((t) => /\$[\d,]+|\d+k\s*(–|-)\s*\$?\d+k|salary|per\s+year|annually/i.test(t))

  if (!allText) return undefined
  if (/\$[\d,]+|\d+k/i.test(allText)) return allText
  return undefined
}

function extractEmploymentType(): string | undefined {
  const all = [...document.querySelectorAll('*')]
    .filter((el) => el.children.length === 0)
  for (const el of all) {
    const t = el.textContent?.trim() ?? ''
    if (/^(Full-time|Part-time|Contract|Temporary|Internship|Volunteer)$/i.test(t)) {
      return t
    }
  }
  return undefined
}

function extractExperienceLevel(): string | undefined {
  const all = [...document.querySelectorAll('*')]
    .filter((el) => el.children.length === 0)
  for (const el of all) {
    const t = el.textContent?.trim() ?? ''
    if (/^(Entry level|Associate|Mid-Senior level|Director|Executive|Internship)$/i.test(t)) {
      return t
    }
  }
  return undefined
}

function parseListsFromDescription(description: string): {
  requirements: string[]
  benefits: string[]
} {
  const lines = description.split('\n').map((l) => l.trim()).filter(Boolean)
  const requirements: string[] = []
  const benefits: string[] = []
  let mode: 'none' | 'req' | 'benefit' = 'none'

  for (const line of lines) {
    if (/^(requirements|qualifications|what you.*(need|bring)|must.have|who you are|minimum qualifications|basic qualifications)/i.test(line)) {
      mode = 'req'
      continue
    }
    if (/^(benefits|perks|what we offer|why join|compensation|our benefits|total rewards)/i.test(line)) {
      mode = 'benefit'
      continue
    }
    // Reset mode on new section headers (all-caps or ends with colon and short)
    if (/^[A-Z][^a-z]{2,}$/.test(line) || (line.endsWith(':') && line.length < 60)) {
      mode = 'none'
      continue
    }

    if (mode === 'req') requirements.push(line)
    else if (mode === 'benefit') benefits.push(line)
  }

  return { requirements, benefits }
}

export function extractJob(): ExtractedJob {
  if (!isJobPostingPage()) {
    throw new Error('Not a LinkedIn job posting page')
  }

  const { title, company, location } = extractFromLazyColumn()
  const description = extractDescription()

  if (!title && !description) {
    throw new Error('Could not extract job content — page may still be loading')
  }

  const { requirements, benefits } = parseListsFromDescription(description)

  return {
    url: window.location.href,
    extracted_at: Date.now(),
    title: title || document.title.split('|')[0].trim(),
    company: company || document.title.split('|')[1]?.trim() || 'Unknown',
    location,
    salary_range: extractSalary(),
    employment_type: extractEmploymentType(),
    experience_level: extractExperienceLevel(),
    description,
    requirements,
    benefits,
  }
}
