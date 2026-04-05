import { type DBSchema, type IDBPDatabase, openDB } from 'idb'

import type { AggregatedReport } from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'

const DB_NAME = 'job-bro'
const DB_VERSION = 1

export interface AnalysisRecord {
  id: string
  job: ExtractedJob
  report: AggregatedReport
  createdAt: number
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
}

let dbPromise: Promise<IDBPDatabase<JobBroDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<JobBroDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('analyses', { keyPath: 'id' })
        store.createIndex('by-created', 'createdAt')
        store.createIndex('by-company', ['job', 'company'])
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
