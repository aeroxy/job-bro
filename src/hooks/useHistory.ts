import { useCallback, useEffect, useState } from 'react'

import {
  type AnalysisRecord,
  clearAnalyses,
  deleteAnalysis,
  getAnalysis,
  getSessionByJobId,
  listAnalyses,
  listSessions,
  pruneOrphanSessions,
  saveSession,
} from '@/lib/db'
import { extractLinkedInJobId } from '@/extractor/linkedin'

async function openOrFocusTab(url: string, jobId?: string): Promise<void> {
  if (jobId) {
    const tabs = await chrome.tabs.query({})
    const existing = tabs.find((t) => t.url && extractLinkedInJobId(t.url) === jobId)
    if (existing?.id) {
      await chrome.tabs.update(existing.id, { active: true })
      if (existing.windowId) chrome.windows.update(existing.windowId, { focused: true })
      return
    }
  }
  chrome.tabs.create({ url })
}

export async function openRecordInLinkedIn(record: AnalysisRecord): Promise<void> {
  await openOrFocusTab(record.job.url, record.job.job_id)
}

export async function restoreRecord(
  record: AnalysisRecord,
  onRestored?: (jobId: string) => void
): Promise<void> {
  if (!record.job.job_id) return

  const existing = await getSessionByJobId(record.job.job_id)
  if (existing?.qnaHistory?.length || existing?.resumeMarkdown) {
    if (!confirm('This will clear Q&A and resume for this job. Continue?')) return
  }

  await saveSession({
    job_id: record.job.job_id,
    job: record.job,
    report: record.report,
    qnaHistory: [],
    resumeMarkdown: null,
    resumeSummary: null,
    updatedAt: Date.now(),
  })

  onRestored?.(record.job.job_id)
  await openOrFocusTab(record.job.url, record.job.job_id)
}

export function useHistory() {
  const [records, setRecords] = useState<AnalysisRecord[]>([])
  const [orphanCount, setOrphanCount] = useState(0)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    const [analyses, sessions] = await Promise.all([listAnalyses(), listSessions()])
    setRecords(analyses)
    setOrphanCount(sessions.filter((s) =>
      s.report === null && s.status !== 'analyzing' && s.status !== 'extracting'
    ).length)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const remove = useCallback(async (id: string) => {
    setRecords((prev) => prev.filter((r) => r.id !== id))
    await deleteAnalysis(id)
  }, [])

  const clearAll = useCallback(async () => {
    await clearAnalyses()
    await refresh()
  }, [refresh])

  const prune = useCallback(async (): Promise<number> => {
    const removed = await pruneOrphanSessions()
    setOrphanCount(0)
    return removed
  }, [])

  const get = useCallback(async (id: string): Promise<AnalysisRecord | undefined> => {
    return getAnalysis(id)
  }, [])

  return { records, orphanCount, loading, refresh, remove, clearAll, prune, get }
}
