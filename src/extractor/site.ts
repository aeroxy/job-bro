import type { ExtractedJob } from '@/types/job'
import {
  extractJob as extractLinkedInJob,
  extractLinkedInJobId,
  waitForJobPostingPage as waitForLinkedInPage,
} from './linkedin'
import {
  extractGreenhouseJob,
  extractGreenhouseJobId,
  isGreenhouseJobUrl,
  waitForGreenhousePage,
} from './greenhouse'

// URL → stable, site-namespaced job_id. Used by hydration, history tab-matching,
// and background gating. The per-site matchers are disjoint (LinkedIn needs
// /jobs/view/ or currentJobId=; Greenhouse needs greenhouse.io/.../jobs/), so
// order doesn't cause cross-matches. LinkedIn ids stay bare-numeric for
// back-compat; Greenhouse ids are prefixed `gh:`.
export function extractJobId(url: string): string | null {
  return extractLinkedInJobId(url) ?? extractGreenhouseJobId(url)
}

export function isSupportedJobUrl(url: string): boolean {
  return extractJobId(url) !== null
}

// --- Page-context dispatch (content script only — touches window/DOM) ---

export async function waitForJobPage(timeoutMs = 2000): Promise<boolean> {
  if (isGreenhouseJobUrl(window.location.href)) return waitForGreenhousePage(timeoutMs)
  return waitForLinkedInPage(timeoutMs)
}

export function extractJobFromPage(): ExtractedJob {
  if (isGreenhouseJobUrl(window.location.href)) return extractGreenhouseJob()
  return extractLinkedInJob()
}
