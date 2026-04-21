import { useCallback, useEffect, useRef, useState } from 'react'

import type { AggregatedReport } from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'
import type { ChatTurn } from '@/types/chat'
import type { AnalysisProgressMessage } from '@/types/messages'
import { getSessionByJobId, saveSession } from '@/lib/db'
import { extractLinkedInJobId } from '@/extractor/linkedin'

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
  qnaHistory: ChatTurn[]
  chatLoading: boolean
  chatNonce: number  // incremented on each new request; stale responses are ignored
  // Track which job_id this session was hydrated from to avoid re-hydrating
  hydratedJobId: string | null
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
  qnaHistory: [],
  chatLoading: false,
  chatNonce: 0,
  hydratedJobId: null,
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

  // Persist session to IndexedDB if it has a job_id
  const persistSession = useCallback(async (tabId: number) => {
    const s = sessionsRef.current.get(tabId)
    if (!s?.job?.job_id) return
    await saveSession({
      job_id: s.job.job_id,
      job: s.job,
      report: s.report,
      qnaHistory: s.qnaHistory,
      resumeMarkdown: s.resumeMarkdown,
      resumeSummary: s.resumeSummary,
      updatedAt: Date.now(),
    })
  }, [])

  // Hydrate session from IndexedDB when a tab becomes active
  const hydrateTab = useCallback(async (tabId: number) => {
    let tabUrl: string | undefined
    try {
      const tab = await chrome.tabs.get(tabId)
      tabUrl = tab.url
    } catch {
      return
    }
    if (!tabUrl) return

    const jobId = extractLinkedInJobId(tabUrl)
    if (!jobId) return

    const existing = sessionsRef.current.get(tabId)
    // Skip if already hydrated from same job
    if (existing?.hydratedJobId === jobId) return

    const persisted = await getSessionByJobId(jobId)
    if (!persisted) {
      // Mark that we checked so we don't re-query on every render
      updateSessionAndRender(tabId, { hydratedJobId: jobId })
      return
    }

    updateSessionAndRender(tabId, {
      hydratedJobId: jobId,
      job: persisted.job,
      report: persisted.report,
      qnaHistory: persisted.qnaHistory,
      resumeMarkdown: persisted.resumeMarkdown,
      resumeSummary: persisted.resumeSummary,
      resumeStatus: persisted.resumeMarkdown ? 'done' : 'idle',
      status: persisted.report ? 'done' : 'idle',
    })
  }, [updateSessionAndRender])

  // Re-render when active tab switches (to show that tab's session)
  useEffect(() => {
    rerender()
    if (activeTabId) {
      hydrateTab(activeTabId)
    }
  }, [activeTabId, rerender, hydrateTab])

  // Listen for URL changes in active tab (user navigates between job postings)
  useEffect(() => {
    const handleUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (tabId !== activeTabIdRef.current) return
      if (!changeInfo.url) return
      const session = sessionsRef.current.get(tabId)
      const newJobId = extractLinkedInJobId(changeInfo.url)
      if (newJobId && newJobId !== session?.hydratedJobId) {
        hydrateTab(tabId)
      }
    }
    chrome.tabs.onUpdated.addListener(handleUpdated)
    return () => chrome.tabs.onUpdated.removeListener(handleUpdated)
  }, [hydrateTab])

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
        await persistSession(tabId)
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
  }, [updateSessionAndRender, persistSession])

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
      qnaHistory: [],
      hydratedJobId: null,
    })
  }, [updateSessionAndRender])

  const deleteChatTurn = useCallback(async (index: number) => {
    const tabId = activeTabIdRef.current
    if (!tabId) return
    const session = getSession(tabId)
    const newHistory = session.qnaHistory.filter((_, i) => i !== index)
    updateSessionAndRender(tabId, { qnaHistory: newHistory })
    await persistSession(tabId)
  }, [getSession, updateSessionAndRender, persistSession])

  // Returns the new nonce; caller passes it back to appendChatTurns / setChatLoading
  // so stale responses from superseded requests are silently dropped.
  const bumpChatNonce = useCallback((tabId: number): number => {
    const session = getSession(tabId)
    const nonce = session.chatNonce + 1
    updateSession(tabId, { chatNonce: nonce })
    return nonce
  }, [getSession, updateSession])

  const setChatLoading = useCallback((tabId: number, loading: boolean, nonce?: number) => {
    if (!loading && nonce !== undefined) {
      // Only clear loading if this request is still the active one
      if (getSession(tabId).chatNonce !== nonce) return
    }
    updateSessionAndRender(tabId, { chatLoading: loading })
  }, [getSession, updateSessionAndRender])

  const appendChatTurns = useCallback(async (turns: ChatTurn[], targetTabId: number, nonce?: number) => {
    const session = getSession(targetTabId)
    if (nonce !== undefined && session.chatNonce !== nonce) return  // superseded by retry
    const newHistory = [...session.qnaHistory, ...turns]
    updateSessionAndRender(targetTabId, { qnaHistory: newHistory })
    await persistSession(targetTabId)
  }, [getSession, updateSessionAndRender, persistSession])

  // Resume generation
  const generateResume = useCallback(async (job: ExtractedJob, analysisContext?: string) => {
    const tabId = activeTabIdRef.current
    if (!tabId) return

    const session = getSession(tabId)

    updateSessionAndRender(tabId, {
      resumeStatus: 'generating',
      resumeError: null,
      resumeMarkdown: null,
      resumeSummary: null,
    })

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GENERATE_RESUME',
        payload: { job, analysisContext, qnaHistory: session.qnaHistory },
      })

      if (response.type === 'RESUME_RESULT') {
        updateSessionAndRender(tabId, {
          resumeMarkdown: response.payload.markdown,
          resumeSummary: response.payload.summary,
          resumeStatus: 'done',
        })
        await persistSession(tabId)
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
  }, [updateSessionAndRender, getSession, persistSession])

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
          qnaHistory: session.qnaHistory,
        },
      })

      if (response.type === 'RESUME_RESULT') {
        updateSessionAndRender(tabId, {
          resumeMarkdown: response.payload.markdown,
          resumeSummary: response.payload.summary,
          resumeStatus: 'done',
        })
        await persistSession(tabId)
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
  }, [updateSessionAndRender, getSession, persistSession])

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

  const invalidateHydration = useCallback((jobId: string) => {
    for (const [tabId, session] of sessionsRef.current.entries()) {
      if (session.hydratedJobId === jobId) {
        sessionsRef.current.set(tabId, { ...session, hydratedJobId: null })
      }
    }
    if (activeTabIdRef.current) {
      hydrateTab(activeTabIdRef.current)
    }
  }, [hydrateTab])

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
    // Q&A
    qnaHistory: current.qnaHistory,
    chatLoading: current.chatLoading,
    appendChatTurns,
    setChatLoading,
    bumpChatNonce,
    deleteChatTurn,
    // Resume
    resumeStatus: current.resumeStatus,
    resumeMarkdown: current.resumeMarkdown,
    resumeError: current.resumeError,
    generateResume,
    regenerateResume,
    setResumeMarkdown,
    resetResume,
    // Session management
    invalidateHydration,
  }
}
