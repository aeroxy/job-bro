import { type DBSchema, type IDBPDatabase, openDB } from 'idb'

import type { AggregatedReport } from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'
import type { ChatTurn } from '@/types/chat'
import { extractLinkedInJobId } from '@/extractor/linkedin'

const DB_NAME = 'job-bro'
const DB_VERSION = 4

export interface AnalysisRecord {
  id: string
  job: ExtractedJob
  report: AggregatedReport
  createdAt: number
}

export type PersistedAnalysisStatus = 'idle' | 'extracting' | 'analyzing' | 'done' | 'error'

type PersistedProgressStatus = 'pending' | 'running' | 'completed' | 'error' | 'blocked'

export interface PersistedEvaluatorProgress {
  job_fit: PersistedProgressStatus
  salary: PersistedProgressStatus
  preference: PersistedProgressStatus
  risk: PersistedProgressStatus
  growth: PersistedProgressStatus
  summary: PersistedProgressStatus
}

export interface PersistedSession {
  job_id: string
  job: ExtractedJob
  report: AggregatedReport | null
  qnaHistory: ChatTurn[]
  resumeMarkdown: string | null
  resumeSummary: string | null
  updatedAt: number
  status?: PersistedAnalysisStatus
  progress?: PersistedEvaluatorProgress
  error?: string
}

interface JobBroDB extends DBSchema {
  analyses: {
    key: string
    value: AnalysisRecord
    indexes: {
      'by-created': number
      'by-company': string
    }
  }
  sessions: {
    key: string
    value: PersistedSession
    indexes: {
      'by-updated': number
    }
  }
}

let dbPromise: Promise<IDBPDatabase<JobBroDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<JobBroDB>(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const store = db.createObjectStore('analyses', { keyPath: 'id' })
          store.createIndex('by-created', 'createdAt')
          store.createIndex('by-company', ['job', 'company'])
        }
        if (oldVersion < 2) {
          const sessions = db.createObjectStore('sessions', { keyPath: 'job_id' })
          sessions.createIndex('by-updated', 'updatedAt')
        }
        // v3 adds optional status/progress to PersistedSession — no schema change needed
        // since IndexedDB stores arbitrary values; the bump just signals upgraders.

        // v4 backfill: pre-v2 analyses never produced a `sessions` row (the
        // store didn't exist yet), and slug-style /jobs/view/<slug>-<id>/ URLs
        // older builds couldn't parse were stored with job_id=undefined — both
        // leave the panel unable to rehydrate. Use the record's job_id when it
        // has one, otherwise re-derive it from job.url (patching the record so
        // History group/Restore/Open work), then synthesize any missing session.
        // Newest report wins per job; an existing session is never clobbered.
        if (oldVersion >= 1 && oldVersion < 4) {
          const analysesStore = tx.objectStore('analyses')
          const sessionsStore = tx.objectStore('sessions')
          const all = await analysesStore.getAll()
          const existingSessionIds = new Set(await sessionsStore.getAllKeys())

          const repairable = all
            .map((r) => ({ r, jobId: r.job?.job_id ?? extractLinkedInJobId(r.job?.url ?? '') }))
            .filter((x): x is { r: AnalysisRecord; jobId: string } => !!x.jobId)
            .sort((a, b) => b.r.createdAt - a.r.createdAt)

          const used = new Set<string>()
          for (const { r, jobId } of repairable) {
            // Only the slug-bug records need their job_id written back.
            if (!r.job?.job_id) {
              await analysesStore.put({ ...r, job: { ...r.job, job_id: jobId } })
            }
            if (existingSessionIds.has(jobId) || used.has(jobId)) continue
            used.add(jobId)
            await sessionsStore.put({
              job_id: jobId,
              job: { ...r.job, job_id: jobId },
              report: r.report,
              qnaHistory: [],
              resumeMarkdown: null,
              resumeSummary: null,
              updatedAt: r.createdAt,
              status: 'done',
            })
          }
        }
      },
    })
  }
  return dbPromise
}

export async function saveAnalysis(
  job: ExtractedJob,
  report: AggregatedReport
): Promise<AnalysisRecord> {
  const db = await getDB()
  const record: AnalysisRecord = {
    id: crypto.randomUUID(),
    job,
    report,
    createdAt: Date.now(),
  }
  await db.put('analyses', record)
  return record
}

export async function listAnalyses(): Promise<AnalysisRecord[]> {
  const db = await getDB()
  const all = await db.getAllFromIndex('analyses', 'by-created')
  return all.reverse()
}

export async function getAnalysis(id: string): Promise<AnalysisRecord | undefined> {
  const db = await getDB()
  return db.get('analyses', id)
}

export async function deleteAnalysis(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('analyses', id)
}

export async function clearAnalyses(): Promise<void> {
  const db = await getDB()
  await db.clear('analyses')
}

export async function saveSession(session: PersistedSession): Promise<void> {
  const db = await getDB()
  await db.put('sessions', session)
}

export async function getSessionByJobId(jobId: string): Promise<PersistedSession | undefined> {
  const db = await getDB()
  return db.get('sessions', jobId)
}

export async function listSessions(): Promise<PersistedSession[]> {
  const db = await getDB()
  const all = await db.getAllFromIndex('sessions', 'by-updated')
  return all.reverse()
}

export async function deleteSession(jobId: string): Promise<void> {
  const db = await getDB()
  await db.delete('sessions', jobId)
}

export async function clearSessions(): Promise<void> {
  const db = await getDB()
  await db.clear('sessions')
}

// In-flight analysis should finish within an hour. Anything older with no
// report is abandoned (crashed, missed broadcast, pre-fix orphan) and safe
// to prune.
export const STALE_IN_FLIGHT_MS = 60 * 60 * 1000

// Delete sessions that were extracted but never produced a report — analyses
// that errored out, were cancelled, or where the user only ran extract. Also
// prunes sessions stuck in 'analyzing'/'extracting' past the staleness
// threshold. Returns the number of records deleted.
export async function pruneOrphanSessions(): Promise<number> {
  const db = await getDB()
  const tx = db.transaction('sessions', 'readwrite')
  const store = tx.objectStore('sessions')
  const now = Date.now()
  let count = 0
  let cursor = await store.openCursor()
  while (cursor) {
    const s = cursor.value
    if (s.report === null) {
      const hasResume = s.resumeMarkdown || s.resumeSummary
      const hasChat = s.qnaHistory && s.qnaHistory.length > 0
      if (!hasResume && !hasChat) {
        const inFlight = s.status === 'analyzing' || s.status === 'extracting'
        const stale = inFlight && (now - s.updatedAt) > STALE_IN_FLIGHT_MS
        if (!inFlight || stale) {
          await cursor.delete()
          count++
        }
      }
    }
    cursor = await cursor.continue()
  }
  await tx.done
  return count
}
