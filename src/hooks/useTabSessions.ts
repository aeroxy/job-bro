import { useCallback, useEffect, useRef, useState } from 'react'

import type { AggregatedReport } from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'
import type { AnalysisProgressMessage } from '@/types/messages'

export type AnalysisStatus = 'idle' | 'extracting' | 'analyzing' | 'done' | 'error'
export type ResumeStatus = 'idle' | 'generating' | 'done' | 'error'

export type TabView =
  | { name: 'main' }
  | { name: 'resume' }

export interface EvaluatorProgress {
  job_fit: 'pending' | 'running' | 'completed' | 'error'
  salary: 'pending' | 'running' | 'completed' | 'error'
  preference: 'pending' | 'running' | 'completed' | 'error'
  risk: 'pending' | 'running' | 'completed' | 'error'
  growth: 'pending' | 'running' | 'completed' | 'error'
  summary: 'pending' | 'running' | 'completed' | 'error'
}

const INITIAL_PROGRESS: EvaluatorProgress = {
  job_fit: 'pending',
  salary: 'pending',
  preference: 'pending',
  risk: 'pending',
  growth: 'pending',
  summary: 'pending',
}

interface TabSession {
  view: TabView
  status: AnalysisStatus
  job: ExtractedJob | null
  report: AggregatedReport | null
  error: string | null
  progress: EvaluatorProgress
  resumeStatus: ResumeStatus
  resumeMarkdown: string | null
  resumeSummary: string | null
  resumeError: string | null
}

const DEFAULT_SESSION: TabSession = {
  view: { name: 'main' },
  status: 'idle',
  job: null,
  report: null,
  error: null,
  progress: INITIAL_PROGRESS,
  resumeStatus: 'idle',
  resumeMarkdown: null,
  resumeSummary: null,
  resumeError: null,
}

export function useTabSessions(
  activeTabId: number | null,
  onTabRemoved: Set<(tabId: number) => void>,
) {
  const sessionsRef = useRef(new Map<number, TabSession>())
  // Increment to force re-render when the active tab's session changes
  const [, setTick] = useState(0)
  const rerender = useCallback(() => setTick((t) => t + 1), [])
  const cancelledRef = useRef(new Set<number>())

  // Helper: get or create a session for a tab
  const getSession = useCallback((tabId: number): TabSession => {
    return sessionsRef.current.get(tabId) ?? { ...DEFAULT_SESSION, progress: { ...INITIAL_PROGRESS } }
  }, [])

  // Helper: update a session and re-render if it's the active tab
  const updateSession = useCallback((tabId: number, patch: Partial<TabSession>) => {
    const session = sessionsRef.current.get(tabId) ?? { ...DEFAULT_SESSION, progress: { ...INITIAL_PROGRESS } }
    sessionsRef.current.set(tabId, { ...session, ...patch })
    // Only trigger re-render if updating the active tab
    // We read activeTabId via closure - but since it changes, we need a ref
  }, [])

  // Keep a ref to activeTabId so we can check it in callbacks
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId

  // Wrapped updateSession that conditionally re-renders
  const updateSessionAndRender = useCallback((tabId: number, patch: Partial<TabSession>) => {
    const session = sessionsRef.current.get(tabId) ?? { ...DEFAULT_SESSION, progress: { ...INITIAL_PROGRESS } }
    sessionsRef.current.set(tabId, { ...session, ...patch })
    if (tabId === activeTabIdRef.current) {
      rerender()
    }
  }, [rerender])

  // Re-render when active tab switches (to show that tab's session)
  useEffect(() => {
    rerender()
  }, [activeTabId, rerender])

  // Clean up sessions when tabs are closed
  useEffect(() => {
    const handleRemoved = (tabId: number) => {
      sessionsRef.current.delete(tabId)
      cancelledRef.current.delete(tabId)
    }
    onTabRemoved.add(handleRemoved)
    return () => { onTabRemoved.delete(handleRemoved) }
  }, [onTabRemoved])

  // Listen for progress updates from background
  useEffect(() => {
    const listener = (message: AnalysisProgressMessage) => {
      if (message.type === 'ANALYSIS_PROGRESS') {
        const { tabId, evaluator, status: evalStatus } = message.payload
        const session = sessionsRef.current.get(tabId)
        if (session) {
          const newProgress = { ...session.progress, [evaluator]: evalStatus }
          sessionsRef.current.set(tabId, { ...session, progress: newProgress })
          if (tabId === activeTabIdRef.current) {
            rerender()
          }
        }
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [rerender])

  const extract = useCallback(async () => {
    const tabId = activeTabIdRef.current
    if (!tabId) return null

    updateSessionAndRender(tabId, {
      status: 'extracting',
      error: null,
      report: null,
      job: null,
    })

    try {
      const response = await chrome.runtime.sendMessage({ type: 'REQUEST_EXTRACTION', tabId })

      if (response.type === 'JD_EXTRACTED') {
        updateSessionAndRender(tabId, { job: response.payload, status: 'idle' })
        return response.payload as ExtractedJob
      } else {
        updateSessionAndRender(tabId, { error: response.error || 'Extraction failed', status: 'error' })
        return null
      }
    } catch (e) {
      updateSessionAndRender(tabId, { error: (e as Error).message, status: 'error' })
      return null
    }
  }, [updateSessionAndRender])

  const analyze = useCallback(async (extractedJob: ExtractedJob) => {
    const tabId = activeTabIdRef.current
    if (!tabId) return null

    cancelledRef.current.delete(tabId)
    updateSessionAndRender(tabId, {
      status: 'analyzing',
      error: null,
      progress: { ...INITIAL_PROGRESS },
    })

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ANALYZE_JD',
        tabId,
        payload: { job: extractedJob },
      })

      if (cancelledRef.current.has(tabId)) return null

      if (response.type === 'ANALYSIS_RESULT') {
        updateSessionAndRender(tabId, { report: response.payload, status: 'done' })
        return response.payload as AggregatedReport
      } else {
        updateSessionAndRender(tabId, { error: response.error || 'Analysis failed', status: 'error' })
        return null
      }
    } catch (e) {
      if (cancelledRef.current.has(tabId)) return null
      updateSessionAndRender(tabId, { error: (e as Error).message, status: 'error' })
      return null
    }
  }, [updateSessionAndRender])

  const stop = useCallback(() => {
    const tabId = activeTabIdRef.current
    if (!tabId) return

    cancelledRef.current.add(tabId)
    chrome.runtime.sendMessage({ type: 'CANCEL_ANALYSIS', tabId }).catch(() => {})
    updateSessionAndRender(tabId, {
      status: 'idle',
      error: null,
      progress: { ...INITIAL_PROGRESS },
    })
  }, [updateSessionAndRender])

  const reset = useCallback(() => {
    const tabId = activeTabIdRef.current
    if (!tabId) return

    cancelledRef.current.add(tabId)
    updateSessionAndRender(tabId, {
      status: 'idle',
      job: null,
      report: null,
      error: null,
      progress: { ...INITIAL_PROGRESS },
    })
  }, [updateSessionAndRender])

  // Resume generation
  const generateResume = useCallback(async (job: ExtractedJob, analysisContext?: string) => {
    const tabId = activeTabIdRef.current
    if (!tabId) return

    updateSessionAndRender(tabId, {
      resumeStatus: 'generating',
      resumeError: null,
      resumeMarkdown: null,
      resumeSummary: null,
    })

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GENERATE_RESUME',
        payload: { job, analysisContext },
      })

      if (response.type === 'RESUME_RESULT') {
        updateSessionAndRender(tabId, {
          resumeMarkdown: response.payload.markdown,
          resumeSummary: response.payload.summary,
          resumeStatus: 'done',
        })
      } else {
        updateSessionAndRender(tabId, {
          resumeError: response.error || 'Resume generation failed',
          resumeStatus: 'error',
        })
      }
    } catch (e) {
      updateSessionAndRender(tabId, {
        resumeError: (e as Error).message,
        resumeStatus: 'error',
      })
    }
  }, [updateSessionAndRender])

  const regenerateResume = useCallback(async (job: ExtractedJob, comment: string) => {
    const tabId = activeTabIdRef.current
    if (!tabId) return

    const session = getSession(tabId)

    updateSessionAndRender(tabId, {
      resumeStatus: 'generating',
      resumeError: null,
    })

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GENERATE_RESUME',
        payload: {
          job,
          previousResume: session.resumeMarkdown ?? undefined,
          previousSummary: session.resumeSummary ?? undefined,
          comment: comment.trim() || undefined,
        },
      })

      if (response.type === 'RESUME_RESULT') {
        updateSessionAndRender(tabId, {
          resumeMarkdown: response.payload.markdown,
          resumeSummary: response.payload.summary,
          resumeStatus: 'done',
        })
      } else {
        updateSessionAndRender(tabId, {
          resumeError: response.error || 'Resume generation failed',
          resumeStatus: 'error',
        })
      }
    } catch (e) {
      updateSessionAndRender(tabId, {
        resumeError: (e as Error).message,
        resumeStatus: 'error',
      })
    }
  }, [updateSessionAndRender, getSession])

  const setResumeMarkdown = useCallback((markdown: string | null) => {
    const tabId = activeTabIdRef.current
    if (!tabId) return
    updateSessionAndRender(tabId, { resumeMarkdown: markdown })
  }, [updateSessionAndRender])

  const resetResume = useCallback(() => {
    const tabId = activeTabIdRef.current
    if (!tabId) return
    updateSessionAndRender(tabId, {
      resumeStatus: 'idle',
      resumeMarkdown: null,
      resumeSummary: null,
      resumeError: null,
    })
  }, [updateSessionAndRender])

  const setTabView = useCallback((view: TabView) => {
    const tabId = activeTabIdRef.current
    if (!tabId) return
    updateSessionAndRender(tabId, { view })
  }, [updateSessionAndRender])

  // Current session for the active tab
  const current = activeTabId ? getSession(activeTabId) : DEFAULT_SESSION

  return {
    // Navigation (per-tab)
    view: current.view,
    setView: setTabView,
    // Analysis
    status: current.status,
    job: current.job,
    report: current.report,
    error: current.error,
    progress: current.progress,
    extract,
    analyze,
    stop,
    reset,
    // Resume
    resumeStatus: current.resumeStatus,
    resumeMarkdown: current.resumeMarkdown,
    resumeError: current.resumeError,
    generateResume,
    regenerateResume,
    setResumeMarkdown,
    resetResume,
  }
}
