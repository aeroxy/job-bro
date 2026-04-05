import { useCallback, useEffect, useState } from 'react'

import type { AggregatedReport } from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'
import type { AnalysisProgressMessage } from '@/types/messages'

export type AnalysisStatus = 'idle' | 'extracting' | 'analyzing' | 'done' | 'error'

export interface EvaluatorProgress {
  job_fit: 'pending' | 'running' | 'completed' | 'error'
  salary: 'pending' | 'running' | 'completed' | 'error'
  preference: 'pending' | 'running' | 'completed' | 'error'
  risk: 'pending' | 'running' | 'completed' | 'error'
  growth: 'pending' | 'running' | 'completed' | 'error'
}

const INITIAL_PROGRESS: EvaluatorProgress = {
  job_fit: 'pending',
  salary: 'pending',
  preference: 'pending',
  risk: 'pending',
  growth: 'pending',
}

export function useAnalysis() {
  const [status, setStatus] = useState<AnalysisStatus>('idle')
  const [job, setJob] = useState<ExtractedJob | null>(null)
  const [report, setReport] = useState<AggregatedReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<EvaluatorProgress>(INITIAL_PROGRESS)

  // Listen for progress updates from background
  useEffect(() => {
    const listener = (message: AnalysisProgressMessage) => {
      if (message.type === 'ANALYSIS_PROGRESS') {
        const { evaluator, status: evalStatus } = message.payload
        setProgress((prev) => ({
          ...prev,
          [evaluator]: evalStatus,
        }))
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  const extract = useCallback(async () => {
    setStatus('extracting')
    setError(null)
    setReport(null)
    setJob(null)

    try {
      const response = await chrome.runtime.sendMessage({ type: 'REQUEST_EXTRACTION' })

      if (response.type === 'JD_EXTRACTED') {
        setJob(response.payload)
        setStatus('idle')
        return response.payload as ExtractedJob
      } else {
        setError(response.error || 'Extraction failed')
        setStatus('error')
        return null
      }
    } catch (e) {
      setError((e as Error).message)
      setStatus('error')
      return null
    }
  }, [])

  const analyze = useCallback(async (extractedJob: ExtractedJob) => {
    setStatus('analyzing')
    setError(null)
    setProgress(INITIAL_PROGRESS)

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ANALYZE_JD',
        payload: { job: extractedJob },
      })

      if (response.type === 'ANALYSIS_RESULT') {
        setReport(response.payload)
        setStatus('done')
        return response.payload as AggregatedReport
      } else {
        setError(response.error || 'Analysis failed')
        setStatus('error')
        return null
      }
    } catch (e) {
      setError((e as Error).message)
      setStatus('error')
      return null
    }
  }, [])

  const reset = useCallback(() => {
    setStatus('idle')
    setJob(null)
    setReport(null)
    setError(null)
    setProgress(INITIAL_PROGRESS)
  }, [])

  return {
    status,
    job,
    report,
    error,
    progress,
    extract,
    analyze,
    reset,
  }
}
