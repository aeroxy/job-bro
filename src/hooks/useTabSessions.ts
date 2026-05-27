import { useCallback, useEffect, useRef, useState } from 'react'

import type { AggregatedReport } from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'
import type { ChatTurn } from '@/types/chat'
import type { LLMConfig } from '@/types/profile'
import type { AnalysisProgressMessage } from '@/types/messages'
import { deleteSession, getSessionByJobId, saveSession } from '@/lib/db'
import { extractLinkedInJobId } from '@/extractor/linkedin'
import { runAnalysis, runResume } from '@/lib/llm-handlers'
import type { ResumeResult } from '@/lib/llm-handlers'

export type AnalysisStatus = 'idle' | 'hydrating' | 'extracting' | 'analyzing' | 'done' | 'error'
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

const COMPLETED_PROGRESS: EvaluatorProgress = {
  job_fit: 'completed',
  salary: 'completed',
  preference: 'completed',
  risk: 'completed',
  growth: 'completed',
  summary: 'completed',
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
  llmConfig: LLMConfig,
) {
  const sessionsRef = useRef(new Map<number, TabSession>())
  // Optimization: secondary mapping for O(1) sibling tab lookups. Maps jobId -> Set of tabIds.
  const jobIdToTabIdsRef = useRef(new Map<string, Set<number>>())

  // Increment to force re-render when the active tab's session changes
  const [, setTick] = useState(0)
  const rerender = useCallback(() => setTick((t) => t + 1), [])
  const cancelledRef = useRef(new Set<number>())
  // AbortControllers for in-sidepanel runs (Chrome backend). Background backend
  // uses CANCEL_ANALYSIS/CANCEL_RESUME messages instead.
  const localAnalysisControllersRef = useRef(new Map<number, AbortController>())
  const localResumeControllersRef = useRef(new Map<number, AbortController>())

  // Track current backend in a ref so callbacks see the latest value without
  // needing to re-create on every config change.
  const backendRef = useRef<LLMConfig['backend']>(llmConfig.backend)
  backendRef.current = llmConfig.backend

  // Per-tab mutex: chains concurrent syncTab() calls for the same tab so they
  // run sequentially, preventing race conditions on session state.
  const syncMutexRef = useRef(new Map<number, Promise<void>>())
  // Per-job analysis lock: ensures only one analysis runs at a time for a given job ID,
  // even across multiple tabs. Subsequent calls return the in-flight promise.
  const analysisPromisesRef = useRef(new Map<string, Promise<AggregatedReport | null>>())

  // Helper: get or create a session for a tab
  const getSession = useCallback((tabId: number): TabSession => {
    return sessionsRef.current.get(tabId) ?? { ...DEFAULT_SESSION, progress: { ...INITIAL_PROGRESS } }
  }, [])

  // Helper: sync the jobIdToTabIdsRef mapping when a session's jobId changes
  const updateJobIdMapping = useCallback((tabId: number, session: TabSession, patch: Partial<TabSession>) => {
    const oldJobId = session.job?.job_id || session.hydratedJobId
    const newJobId = ('job' in patch)
      ? (patch.job?.job_id || null)
      : ('hydratedJobId' in patch ? patch.hydratedJobId : oldJobId)

    if (oldJobId && oldJobId !== newJobId) {
      const set = jobIdToTabIdsRef.current.get(oldJobId)
      set?.delete(tabId)
      if (set?.size === 0) {
        jobIdToTabIdsRef.current.delete(oldJobId)
      }
    }
    if (newJobId) {
      if (!jobIdToTabIdsRef.current.has(newJobId)) {
        jobIdToTabIdsRef.current.set(newJobId, new Set())
      }
      jobIdToTabIdsRef.current.get(newJobId)!.add(tabId)
    }
    return newJobId
  }, [])

  // Helper: update a session and re-render if it's the active tab
  const updateSession = useCallback((tabId: number, patch: Partial<TabSession>) => {
    const session = sessionsRef.current.get(tabId) ?? { ...DEFAULT_SESSION, progress: { ...INITIAL_PROGRESS } }
    const newJobId = updateJobIdMapping(tabId, session, patch)
    sessionsRef.current.set(tabId, { ...session, ...patch, hydratedJobId: newJobId ?? null })
  }, [updateJobIdMapping])

  // Keep a ref to activeTabId so we can check it in callbacks
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId

  // Wrapped updateSession that conditionally re-renders. Also propagates
  // updates to other tabs viewing the same jobId so state/progress remains synchronized.
  // Note: Propagating the entire patch (including UI view states like `view`) is intentional
  // so that sidepanels viewing the same job remain in sync (e.g. flipping to the resume
  // view on one tab updates the other tab's sidepanel to match).
  const updateSessionAndRender = useCallback((tabId: number, patch: Partial<TabSession>) => {
    const session = sessionsRef.current.get(tabId) ?? { ...DEFAULT_SESSION, progress: { ...INITIAL_PROGRESS } }
    const oldJobId = session.job?.job_id || session.hydratedJobId
    const newJobId = updateJobIdMapping(tabId, session, patch)

    const updated = { ...session, ...patch, hydratedJobId: newJobId ?? null }
    sessionsRef.current.set(tabId, updated)
    
    let shouldRerender = tabId === activeTabIdRef.current

    const targetJobId = newJobId || oldJobId
    if (targetJobId) {
      const siblings = jobIdToTabIdsRef.current.get(targetJobId)
      if (siblings) {
        for (const tId of siblings) {
          if (tId === tabId) continue
          const s = sessionsRef.current.get(tId)
          if (s) {
            sessionsRef.current.set(tId, { ...s, ...patch, hydratedJobId: newJobId ?? null })
            if (tId === activeTabIdRef.current) {
              shouldRerender = true
            }
          }
        }
      }
    }

    if (shouldRerender) {
      rerender()
    }
  }, [rerender, updateJobIdMapping])

  // Cancel the in-flight analysis for a tab AND any sibling tabs viewing the
  // same jobId. Marks all related tabIds in cancelledRef, aborts the local
  // AbortController (Chrome backend), and sends CANCEL_ANALYSIS to background
  // (cloud backend). This ensures that clicking "Stop" from a sibling tab
  // actually reaches the controller keyed under the originating tab's ID.
  const cancelAnalysis = useCallback((tabId: number) => {
    const session = sessionsRef.current.get(tabId)
    const jobId = session?.job?.job_id

    // Collect all tab IDs to cancel: the given tab + any siblings with the same jobId
    const toCancel = new Set<number>([tabId])
    if (jobId) {
      const siblings = jobIdToTabIdsRef.current.get(jobId)
      siblings?.forEach((tId) => toCancel.add(tId))
    }

    for (const tId of toCancel) {
      cancelledRef.current.add(tId)
      localAnalysisControllersRef.current.get(tId)?.abort(new DOMException('User stopped analysis', 'AbortError'))
      localAnalysisControllersRef.current.delete(tId)
      chrome.runtime.sendMessage({ type: 'CANCEL_ANALYSIS', tabId: tId }).catch(() => {})
    }
  }, [])

  // Cancel the in-flight resume generation for a tab AND any sibling tabs
  // viewing the same jobId.
  const cancelResume = useCallback((tabId: number) => {
    const session = sessionsRef.current.get(tabId)
    const jobId = session?.job?.job_id

    const toCancel = new Set<number>([tabId])
    if (jobId) {
      const siblings = jobIdToTabIdsRef.current.get(jobId)
      siblings?.forEach((tId) => toCancel.add(tId))
    }

    for (const tId of toCancel) {
      cancelledRef.current.add(tId)
      localResumeControllersRef.current.get(tId)?.abort(new DOMException('User stopped resume generation', 'AbortError'))
      localResumeControllersRef.current.delete(tId)
      chrome.runtime.sendMessage({ type: 'CANCEL_RESUME', tabId: tId }).catch(() => {})
    }
  }, [])

  // Persist session to IndexedDB if it has a job_id. Captures the current
  // status + progress so that an interrupted run (sidepanel closed mid-analyze)
  // can be surfaced on rehydrate, instead of silently reverting to 'idle'.
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
      // 'hydrating' is a transient UI state, never useful to persist
      status: s.status === 'hydrating' ? 'idle' : s.status,
      progress: s.progress,
    })
  }, [])

  // Sync the panel's view of a tab with that tab's current URL. Single entry
  // point for both tab-switches (onActivated) and URL changes within a tab
  // (onUpdated / SPA navigation). Eliminates the gap where stale content from
  // a previous tab is visible while the new tab's state loads.
  //
  // Semantics:
  // - Tab switch (fromUrlChange:false) onto a mid-run tab: do nothing — the
  //   in-flight analyzer is the source of truth, show its spinner.
  // - URL change (fromUrlChange:true) while mid-run: cancel the in-flight run,
  //   then resync with the new URL.
  // - Non-LinkedIn URL: reset to idle empty state (no stale content).
  // - LinkedIn job URL: synchronous reset to 'hydrating', then async IDB load.
  // - IDB record with persisted status='analyzing'/'extracting': treat as
  //   interrupted, surface an error with retry hint.
  const syncTab = useCallback(async (tabId: number, opts: { fromUrlChange?: boolean } = {}) => {
    // Chain onto any in-flight sync for this tab to prevent races.
    // Wrap in an IIFE and catch errors on `prev` to prevent any failed sync
    // task from breaking all future sync updates in the promise chain.
    const prev = syncMutexRef.current.get(tabId) ?? Promise.resolve()
    const run = (async () => {
    try {
      await prev
    } catch {}

    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      if (!tab) return // tab closed during the await
      const tabUrl = tab.url

      const current = sessionsRef.current.get(tabId)
      const midRun = current?.status === 'analyzing' || current?.status === 'extracting'
      const jobId = tabUrl ? extractLinkedInJobId(tabUrl) : null
      const currentJobId = current?.job?.job_id || current?.hydratedJobId
      // URL change while mid-run — only cancel if the job actually changed
      // (e.g. not just tracking params or hash fragment updates).
      if (midRun && opts.fromUrlChange && currentJobId !== jobId) {
        const siblings = currentJobId ? jobIdToTabIdsRef.current.get(currentJobId) : null
        const otherTabsViewingJob = Array.from(siblings ?? []).filter((t) => t !== tabId)

        if (otherTabsViewingJob.length === 0) {
          cancelAnalysis(tabId)
        }
      }

      // Fast path: same job already loaded, nothing to do.
      if (current && current.hydratedJobId === jobId) {
        return
      }

      // Synchronous reset before async IDB fetch — kills stale content immediately.
      // Note: We MUST call updateJobIdMapping before overwriting sessionsRef to 
      // ensure the old jobId is correctly identified and cleaned up from the mapping.
      const resetSession: TabSession = {
        ...DEFAULT_SESSION,
        progress: { ...INITIAL_PROGRESS },
        status: (jobId ? 'hydrating' : 'idle') as AnalysisStatus,
      }
      if (current) {
        updateJobIdMapping(tabId, current, resetSession)
      }
      sessionsRef.current.set(tabId, resetSession)
      if (tabId === activeTabIdRef.current) rerender()

      if (!jobId) {
        updateSessionAndRender(tabId, { hydratedJobId: null })
        return
      }

      const persisted = await getSessionByJobId(jobId)

      // Tab may have navigated again during the IDB read — bail if so.
      const latest = sessionsRef.current.get(tabId)
      if (!latest || latest.status !== 'hydrating') return

      if (!persisted) {
        updateSessionAndRender(tabId, { hydratedJobId: jobId, status: 'idle' })
        return
      }

      // Check if another tab is actively running this analysis right now
      const activeSiblingSession = (() => {
        if (!jobId) return null
        const siblings = jobIdToTabIdsRef.current.get(jobId)
        if (!siblings) return null
        for (const tId of siblings) {
          if (tId === tabId) continue
          const s = sessionsRef.current.get(tId)
          if (s?.status === 'analyzing' || s?.status === 'extracting') return s
        }
        return null
      })()

      const wasInterrupted =
        !activeSiblingSession &&
        (persisted.status === 'analyzing' || persisted.status === 'extracting')

      if (activeSiblingSession) {
        updateSessionAndRender(tabId, {
          hydratedJobId: jobId,
          job: activeSiblingSession.job,
          report: activeSiblingSession.report,
          qnaHistory: activeSiblingSession.qnaHistory,
          resumeMarkdown: activeSiblingSession.resumeMarkdown,
          resumeSummary: activeSiblingSession.resumeSummary,
          resumeStatus: activeSiblingSession.resumeStatus,
          status: activeSiblingSession.status,
          progress: activeSiblingSession.progress,
          error: activeSiblingSession.error,
        })
      } else {
        updateSessionAndRender(tabId, {
          hydratedJobId: jobId,
          job: persisted.job,
          report: persisted.report,
          qnaHistory: persisted.qnaHistory,
          resumeMarkdown: persisted.resumeMarkdown,
          resumeSummary: persisted.resumeSummary,
          resumeStatus: (persisted.resumeMarkdown ? 'done' : 'idle') as ResumeStatus,
          status: (wasInterrupted ? 'error' : persisted.report ? 'done' : 'idle') as AnalysisStatus,
          progress: persisted.report ? { ...COMPLETED_PROGRESS } : { ...INITIAL_PROGRESS },
          error: wasInterrupted
            ? 'Previous analysis was interrupted. Click Analyze to retry.'
            : null,
        })
      }
    } catch (err) {
      console.error(`[Job Bro] syncTab failed for tab ${tabId}:`, err)
      // Surface the error only if the session still exists and is hydrating.
      // A closed tab will have its session cleaned up by onRemoved, so we
      // must not recreate it here.
      const latest = sessionsRef.current.get(tabId)
      if (latest?.status === 'hydrating') {
        updateSessionAndRender(tabId, {
          status: 'error',
          error: 'Failed to load tab state. Please try again.',
        })
      }
    }
    })()
    
    const finalRun = run.finally(() => {
      // Garbage-collect the mutex slot once this run is the latest. If another
      // call has chained on after us, leave its `run` in place.
      if (syncMutexRef.current.get(tabId) === finalRun) {
        syncMutexRef.current.delete(tabId)
      }
    })
    syncMutexRef.current.set(tabId, finalRun)
    return finalRun
  }, [cancelAnalysis, updateSessionAndRender, rerender])

  // Sync when active tab switches
  useEffect(() => {
    if (activeTabId) syncTab(activeTabId)
  }, [activeTabId, syncTab])

  // Sync when the active tab's URL changes (address bar, link click, SPA pushState).
  // Re-syncs regardless of whether the new URL is a LinkedIn job page — navigating
  // *off* LinkedIn must clear the panel, not leave the old analysis visible.
  useEffect(() => {
    const handleUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (tabId !== activeTabIdRef.current) return
      if (!changeInfo.url) return
      syncTab(tabId, { fromUrlChange: true })
    }
    chrome.tabs.onUpdated.addListener(handleUpdated)
    return () => chrome.tabs.onUpdated.removeListener(handleUpdated)
  }, [syncTab])

  // Content script broadcasts URL_CHANGED on LinkedIn SPA navigation (history.pushState),
  // which chrome.tabs.onUpdated may miss. Same handler, treat as URL change.
  useEffect(() => {
    const listener = (message: { type?: string }, sender: chrome.runtime.MessageSender) => {
      if (message?.type !== 'URL_CHANGED') return
      const tabId = sender.tab?.id
      if (tabId == null || tabId !== activeTabIdRef.current) return
      syncTab(tabId, { fromUrlChange: true })
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [syncTab])

  // Clean up sessions when tabs are closed
  useEffect(() => {
    const handleRemoved = (tabId: number) => {
      const session = sessionsRef.current.get(tabId)
      const jobId = session?.job?.job_id || session?.hydratedJobId

      // If the closed tab was the initiator, transition sibling tabs
      // to idle so they don't stay stuck indefinitely. Only
      // trigger when the closed tab owns the AbortController,
      // not when a follower tab is closed.
      const ownsAnalysis = localAnalysisControllersRef.current.has(tabId)
      const ownsResume = localResumeControllersRef.current.has(tabId)

      if (jobId && (ownsAnalysis || ownsResume) && (session?.status === 'analyzing' || session?.status === 'extracting' || session?.resumeStatus === 'generating')) {
        const siblings = jobIdToTabIdsRef.current.get(jobId)
        if (siblings) {
          let shouldRerender = false
          for (const tId of siblings) {
            if (tId === tabId) continue
            const s = sessionsRef.current.get(tId)
            if (s && (s.status === 'analyzing' || s.status === 'extracting' || s.resumeStatus === 'generating')) {
              sessionsRef.current.set(tId, {
                ...s,
                status: (s.status === 'analyzing' || s.status === 'extracting') ? 'idle' : s.status,
                resumeStatus: s.resumeStatus === 'generating' ? 'idle' : s.resumeStatus,
                progress: (s.status === 'analyzing' || s.status === 'extracting') ? { ...INITIAL_PROGRESS } : s.progress,
              })
              persistSession(tId).catch(() => {})
              if (tId === activeTabIdRef.current) shouldRerender = true
            }
          }
          if (shouldRerender) rerender()
        }
      }

      if (jobId) {
        const set = jobIdToTabIdsRef.current.get(jobId)
        set?.delete(tabId)
        if (set?.size === 0) {
          jobIdToTabIdsRef.current.delete(jobId)
        }
      }

      sessionsRef.current.delete(tabId)
      // Mark as cancelled before aborting so siblings don't treat it as a real error
      cancelledRef.current.add(tabId)
      localAnalysisControllersRef.current.get(tabId)?.abort(new DOMException('Tab was closed', 'AbortError'))
      localAnalysisControllersRef.current.delete(tabId)
      localResumeControllersRef.current.get(tabId)?.abort(new DOMException('Tab was closed', 'AbortError'))
      localResumeControllersRef.current.delete(tabId)
      syncMutexRef.current.delete(tabId)
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
        // Skip if no session exists — don't spawn a default one for a stale
        // progress message. updateSessionAndRender would auto-create otherwise.
        if (!session) return
        updateSessionAndRender(tabId, {
          progress: { ...session.progress, [evaluator]: evalStatus },
        })
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [updateSessionAndRender])

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

  // In-sidepanel analysis dispatch for the Chrome backend. Owns the local
  // AbortController, streams evaluator-progress updates straight into the
  // session map (no chrome.runtime round-trip), and persists on success.
  const runLocalAnalysis = useCallback(async (
    tabId: number,
    extractedJob: ExtractedJob,
  ): Promise<AggregatedReport | null> => {
    localAnalysisControllersRef.current.get(tabId)?.abort()
    const controller = new AbortController()
    localAnalysisControllersRef.current.set(tabId, controller)

    const onProgress = (evaluator: string, status: 'running' | 'completed' | 'error') => {
      const session = sessionsRef.current.get(tabId)
      // Skip if no session exists — don't spawn a default one for a late
      // callback (e.g. fired after reset). updateSessionAndRender would
      // auto-create otherwise.
      if (!session) return
      updateSessionAndRender(tabId, {
        progress: { ...session.progress, [evaluator]: status },
      })
    }

    try {
      const result = await runAnalysis(extractedJob, controller.signal, onProgress)
      if (cancelledRef.current.has(tabId)) return null
      if (result.ok) {
        updateSessionAndRender(tabId, { report: result.report, status: 'done' })
        await persistSession(tabId)
        return result.report
      }
      updateSessionAndRender(tabId, { error: result.error, status: 'error' })
      await persistSession(tabId)
      return null
    } catch (e) {
      if (cancelledRef.current.has(tabId)) return null
      updateSessionAndRender(tabId, { error: (e as Error).message, status: 'error' })
      await persistSession(tabId)
      return null
    } finally {
      localAnalysisControllersRef.current.delete(tabId)
    }
  }, [updateSessionAndRender, persistSession])

  // Background-worker analysis dispatch for the cloud (HTTP) backend. The
  // worker fans out evaluators in parallel and broadcasts ANALYSIS_PROGRESS
  // messages, which a separate effect (above) folds into the session state.
  const runRemoteAnalysis = useCallback(async (
    tabId: number,
    extractedJob: ExtractedJob,
  ): Promise<AggregatedReport | null> => {
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
      }
      updateSessionAndRender(tabId, { error: response.error || 'Analysis failed', status: 'error' })
      await persistSession(tabId)
      return null
    } catch (e) {
      if (cancelledRef.current.has(tabId)) return null
      updateSessionAndRender(tabId, { error: (e as Error).message, status: 'error' })
      await persistSession(tabId)
      return null
    }
  }, [updateSessionAndRender, persistSession])

  const analyze = useCallback(async (extractedJob: ExtractedJob) => {
    const tabId = activeTabIdRef.current
    if (!tabId) return null

    const jobId = extractedJob.job_id
    if (jobId) {
      const existing = analysisPromisesRef.current.get(jobId)
      if (existing) return existing
    }

    const run = (async () => {
      cancelledRef.current.delete(tabId)
      updateSessionAndRender(tabId, {
        job: extractedJob,
        status: 'analyzing',
        error: null,
        report: null,
        progress: { ...INITIAL_PROGRESS },
      })
      // Persist the analyzing state BEFORE kicking off the run so an interrupted
      // run (panel closed mid-analyze) is guaranteed to be recoverable on rehydrate.
      try {
        await persistSession(tabId)
      } catch (e) {
        console.error('[Job Bro] Failed to persist initial analysis state:', e)
      }

      return backendRef.current === 'chrome-prompt'
        ? runLocalAnalysis(tabId, extractedJob)
        : runRemoteAnalysis(tabId, extractedJob)
    })()

    if (jobId) {
      analysisPromisesRef.current.set(jobId, run)
      run.finally(() => {
        if (analysisPromisesRef.current.get(jobId) === run) {
          analysisPromisesRef.current.delete(jobId)
        }
      })
    }

    return run
  }, [updateSessionAndRender, persistSession, runLocalAnalysis, runRemoteAnalysis])

  const stop = useCallback(() => {
    const tabId = activeTabIdRef.current
    if (!tabId) return

    // Cancel analysis and resume generation on this tab and any siblings viewing the same job.
    cancelAnalysis(tabId)
    cancelResume(tabId)
    const session = sessionsRef.current.get(tabId)
    const jobId = session?.job?.job_id || session?.hydratedJobId

    const currentSession = sessionsRef.current.get(tabId)
    updateSessionAndRender(tabId, {
      status: (currentSession?.status === 'analyzing' || currentSession?.status === 'extracting') ? 'idle' : currentSession?.status,
      error: null,
      progress: (currentSession?.status === 'analyzing' || currentSession?.status === 'extracting') ? { ...INITIAL_PROGRESS } : currentSession?.progress,
      resumeStatus: currentSession?.resumeStatus === 'generating' ? 'idle' : currentSession?.resumeStatus,
      resumeError: currentSession?.resumeStatus === 'generating' ? null : currentSession?.resumeError,
    })
    // Persist so a stopped run isn't later mistaken for an interrupted one.
    persistSession(tabId).catch(() => {})

    // Also reset sibling tabs to idle for both analysis and resume status
    if (jobId) {
      const siblings = jobIdToTabIdsRef.current.get(jobId)
      if (siblings) {
        let shouldRerender = false
        for (const tId of siblings) {
          if (tId === tabId) continue
          const s = sessionsRef.current.get(tId)
          if (s) {
            sessionsRef.current.set(tId, {
              ...s,
              status: (s.status === 'analyzing' || s.status === 'extracting') ? 'idle' : s.status,
              progress: (s.status === 'analyzing' || s.status === 'extracting') ? { ...INITIAL_PROGRESS } : s.progress,
              resumeStatus: s.resumeStatus === 'generating' ? 'idle' : s.resumeStatus,
              resumeError: s.resumeStatus === 'generating' ? null : s.resumeError,
            })
            persistSession(tId).catch(() => {})
            if (tId === activeTabIdRef.current) shouldRerender = true
          }
        }
        if (shouldRerender) rerender()
      }
    }
  }, [cancelAnalysis, cancelResume, updateSessionAndRender, persistSession, rerender])

  const reset = useCallback(() => {
    const tabId = activeTabIdRef.current
    if (!tabId) return

    // Capture job_id before clearing the in-memory session so we can drop the
    // matching IDB record. "New Analysis" means actually new — the persisted
    // chat/resume scratch work for this job is discarded. The historical
    // analysis record in the separate `analyses` store is unaffected and
    // remains restorable from the History view.
    const jobId = sessionsRef.current.get(tabId)?.job?.job_id

    cancelAnalysis(tabId)
    cancelResume(tabId)
    updateSessionAndRender(tabId, {
      status: 'idle',
      job: null,
      report: null,
      error: null,
      progress: { ...INITIAL_PROGRESS },
      qnaHistory: [],
      hydratedJobId: null,
      resumeStatus: 'idle',
      resumeMarkdown: null,
      resumeSummary: null,
      resumeError: null,
    })
    if (jobId) deleteSession(jobId).catch(() => {})
  }, [cancelAnalysis, cancelResume, updateSessionAndRender])

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

  // Shared helper for resume generation/regeneration. Handles controller
  // lifecycle, supersession, and error mapping so callers only supply the
  // differing dispatch logic.
  const runResumeGeneration = useCallback(async (
    tabId: number,
    initialPatch: Partial<TabSession>,
    work: (signal: AbortSignal) => Promise<ResumeResult>,
  ) => {
    updateSessionAndRender(tabId, initialPatch)

    localResumeControllersRef.current.get(tabId)?.abort(new DOMException('New resume generation started', 'AbortError'))
    cancelledRef.current.delete(tabId)
    const controller = new AbortController()
    localResumeControllersRef.current.set(tabId, controller)

    try {
      const result = await work(controller.signal)

      if (localResumeControllersRef.current.get(tabId) !== controller) return
      if (cancelledRef.current.has(tabId)) return

      if (result.ok) {
        updateSessionAndRender(tabId, {
          resumeMarkdown: result.markdown,
          resumeSummary: result.summary,
          resumeStatus: 'done',
        })
        await persistSession(tabId)
      } else {
        updateSessionAndRender(tabId, { resumeError: result.error, resumeStatus: 'error' })
      }
    } catch (e) {
      if (localResumeControllersRef.current.get(tabId) !== controller) return
      if (cancelledRef.current.has(tabId) || (e as Error).name === 'AbortError') return
      updateSessionAndRender(tabId, {
        resumeError: (e as Error).message,
        resumeStatus: 'error',
      })
    } finally {
      if (localResumeControllersRef.current.get(tabId) === controller) {
        localResumeControllersRef.current.delete(tabId)
      }
    }
  }, [updateSessionAndRender, persistSession])

  const generateResume = useCallback(async (job: ExtractedJob, analysisContext?: string) => {
    const tabId = activeTabIdRef.current
    if (!tabId) return
    const session = getSession(tabId)

    await runResumeGeneration(tabId, {
      resumeStatus: 'generating',
      resumeError: null,
      resumeMarkdown: null,
      resumeSummary: null,
    }, async (signal) => {
      if (backendRef.current === 'chrome-prompt') {
        return runResume(job, analysisContext, undefined, undefined, undefined, session.qnaHistory, signal)
      }
      const response = await chrome.runtime.sendMessage({
        type: 'GENERATE_RESUME',
        tabId,
        payload: { job, analysisContext, qnaHistory: session.qnaHistory },
      })
      return response.type === 'RESUME_RESULT'
        ? { ok: true, markdown: response.payload.markdown, summary: response.payload.summary }
        : { ok: false, error: response.error || 'Resume generation failed' }
    })
  }, [getSession, runResumeGeneration])

  const regenerateResume = useCallback(async (job: ExtractedJob, comment: string) => {
    const tabId = activeTabIdRef.current
    if (!tabId) return
    const session = getSession(tabId)

    await runResumeGeneration(tabId, {
      resumeStatus: 'generating',
      resumeError: null,
    }, async (signal) => {
      if (backendRef.current === 'chrome-prompt') {
        return runResume(
          job,
          undefined,
          session.resumeMarkdown ?? undefined,
          session.resumeSummary ?? undefined,
          comment.trim() || undefined,
          session.qnaHistory,
          signal,
        )
      }
      const response = await chrome.runtime.sendMessage({
        type: 'GENERATE_RESUME',
        tabId,
        payload: {
          job,
          previousResume: session.resumeMarkdown ?? undefined,
          previousSummary: session.resumeSummary ?? undefined,
          comment: comment.trim() || undefined,
          qnaHistory: session.qnaHistory,
        },
      })
      return response.type === 'RESUME_RESULT'
        ? { ok: true, markdown: response.payload.markdown, summary: response.payload.summary }
        : { ok: false, error: response.error || 'Resume generation failed' }
    })
  }, [getSession, runResumeGeneration])

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
      syncTab(activeTabIdRef.current, { fromUrlChange: true })
    }
  }, [syncTab])

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
