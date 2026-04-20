import { type DBSchema, type IDBPDatabase, openDB } from 'idb'

import type { AggregatedReport } from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'
import type { ChatTurn } from '@/types/chat'

const DB_NAME = 'job-bro'
const DB_VERSION = 2

export interface AnalysisRecord {
  id: string
  job: ExtractedJob
  report: AggregatedReport
  createdAt: number
}

export interface PersistedSession {
  job_id: string
  job: ExtractedJob
  report: AggregatedReport | null
  qnaHistory: ChatTurn[]
  resumeMarkdown: string | null
  resumeSummary: string | null
  updatedAt: number
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
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const store = db.createObjectStore('analyses', { keyPath: 'id' })
          store.createIndex('by-created', 'createdAt')
          store.createIndex('by-company', ['job', 'company'])
        }
        if (oldVersion < 2) {
          const sessions = db.createObjectStore('sessions', { keyPath: 'job_id' })
          sessions.createIndex('by-updated', 'updatedAt')
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
