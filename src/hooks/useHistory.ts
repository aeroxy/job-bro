import { useCallback, useEffect, useState } from 'react'

import {
  type AnalysisRecord,
  clearAnalyses,
  deleteAnalysis,
  getAnalysis,
  listAnalyses,
} from '@/lib/db'

export function useHistory() {
  const [records, setRecords] = useState<AnalysisRecord[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    const all = await listAnalyses()
    setRecords(all)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const remove = useCallback(
    async (id: string) => {
      await deleteAnalysis(id)
      await refresh()
    },
    [refresh]
  )

  const clearAll = useCallback(async () => {
    await clearAnalyses()
    await refresh()
  }, [refresh])

  const get = useCallback(async (id: string) => {
    return getAnalysis(id)
  }, [])

  return { records, loading, refresh, remove, clearAll, get }
}
