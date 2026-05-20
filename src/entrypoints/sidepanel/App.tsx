import { Briefcase, Cpu, Download, FileText, History, RefreshCw, Search, Settings, Square, User, Zap } from 'lucide-react'
import { useCallback, useState } from 'react'

import { AnalysisReport } from '@/components/AnalysisReport'
import { HistoryDetail } from '@/components/HistoryDetail'
import { HistoryList } from '@/components/HistoryList'
import { JobSummaryCard } from '@/components/JobSummaryCard'
import { ProfileForm } from '@/components/ProfileForm'
import { ResumeView } from '@/components/ResumeView'
import { SettingsForm } from '@/components/SettingsForm'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useActiveTab } from '@/hooks/useActiveTab'
import { useChromeAiStatus } from '@/hooks/useChromeAiStatus'
import { useProfile } from '@/hooks/useProfile'
import { useTabSessions } from '@/hooks/useTabSessions'
import { saveAnalysis } from '@/lib/db'
import { formatAnalysisContext } from '@/lib/analysis-context'

// Global views not tied to any specific tab
type GlobalView =
  | { name: 'profile' }
  | { name: 'settings' }
  | { name: 'history' }
  | { name: 'history-detail'; analysisId: string }

export default function App() {
  // Global navigation (profile, settings, history are not tab-specific)
  const [globalView, setGlobalView] = useState<GlobalView | null>(null)

  const {
    profile,
    llmConfig,
    llmProfiles,
    activeProfileId,
    customPromptChrome,
    activeCustomPrompt,
    loading: profileLoading,
    isProfileComplete,
    isLLMConfigured,
    updateProfile,
    updateCustomPromptChrome,
    saveLLMProfile,
    deleteLLMProfile,
    selectLLMProfile,
  } = useProfile()

  const { activeTabId, onTabRemoved } = useActiveTab()
  const chromeAi = useChromeAiStatus()

  const {
    view: tabView,
    setView: setTabView,
    status,
    job,
    report,
    error,
    progress,
    extract,
    analyze,
    stop,
    reset,
    qnaHistory,
    chatLoading,
    appendChatTurns,
    setChatLoading,
    bumpChatNonce,
    deleteChatTurn,
    resumeStatus,
    resumeMarkdown,
    resumeError,
    generateResume,
    regenerateResume,
    setResumeMarkdown,
    resetResume,
    invalidateHydration,
  } = useTabSessions(activeTabId, onTabRemoved, llmConfig)

  const handleRestore = useCallback((jobId: string) => {
    invalidateHydration(jobId)
    setGlobalView(null)
  }, [invalidateHydration])

  const handleExtract = useCallback(async () => {
    await extract()
  }, [extract])

  const handleAnalyze = useCallback(async () => {
    if (!job) return
    const result = await analyze(job)
    if (result) {
      await saveAnalysis(job, result)
    }
  }, [job, analyze])

  const handleExtractAndAnalyze = useCallback(async () => {
    const extractedJob = await extract()
    if (!extractedJob) return
    const result = await analyze(extractedJob)
    if (result) {
      await saveAnalysis(extractedJob, result)
    }
  }, [extract, analyze])

  const handleGenerateResume = useCallback(async () => {
    if (!job) return
    setTabView({ name: 'resume' })
    if (resumeMarkdown) return // already have one — just view it
    generateResume(job, report ? formatAnalysisContext(report) : undefined)
  }, [job, report, resumeMarkdown, generateResume, setTabView])

  // --- View routing ---

  // Global views take priority over per-tab views
  if (globalView?.name === 'profile') {
    return (
      <ProfileForm
        profile={profile}
        onSave={updateProfile}
        onBack={() => setGlobalView(null)}
      />
    )
  }

  if (globalView?.name === 'settings') {
    return (
      <SettingsForm
        llmConfig={llmConfig}
        llmProfiles={llmProfiles}
        activeProfileId={activeProfileId}
        customPromptChrome={customPromptChrome}
        onSaveLLMProfile={saveLLMProfile}
        onDeleteLLMProfile={deleteLLMProfile}
        onSelectLLMProfile={selectLLMProfile}
        onSavePromptChrome={updateCustomPromptChrome}
        onBack={() => setGlobalView(null)}
      />
    )
  }

  if (globalView?.name === 'history') {
    return (
      <HistoryList
        onSelect={(id) => setGlobalView({ name: 'history-detail', analysisId: id })}
        onBack={() => setGlobalView(null)}
        onRestore={handleRestore}
      />
    )
  }

  if (globalView?.name === 'history-detail') {
    return (
      <HistoryDetail
        analysisId={globalView.analysisId}
        onBack={() => setGlobalView({ name: 'history' })}
        onRestore={handleRestore}
      />
    )
  }

  if (tabView.name === 'resume') {
    return (
      <ResumeView
        job={job!}
        markdown={resumeMarkdown}
        status={resumeStatus}
        error={resumeError}
        onMarkdownChange={setResumeMarkdown}
        onRegenerate={(comment) => job && regenerateResume(job, comment)}
        onBack={() => setTabView({ name: 'main' })}
      />
    )
  }

  // --- Main view ---

  const isWorking = status === 'extracting' || status === 'analyzing'
  const isHydrating = status === 'hydrating'
  const usingChrome = llmConfig.backend === 'chrome-prompt'
  const chromeBlocked = usingChrome && chromeAi.status !== 'available'
  const canAnalyze = isProfileComplete && isLLMConfigured && !chromeBlocked
  const showSetupHints = !isProfileComplete || !isLLMConfigured

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setGlobalView({ name: 'profile' })}
            className="cursor-pointer"
          >
            <User className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setGlobalView({ name: 'history' })}
            className="cursor-pointer"
          >
            <History className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setGlobalView({ name: 'settings' })}
            className="cursor-pointer"
          >
            <Settings className="size-3.5" />
          </Button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Setup hints */}
        {showSetupHints && (
          <div className="border border-dashed rounded-lg p-3 space-y-2">
            <p className="text-xs font-medium">Setup needed:</p>
            {!isProfileComplete && (
              <button
                onClick={() => setGlobalView({ name: 'profile' })}
                className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
              >
                <User className="size-3" />
                Set up your profile (resume, salary, preferences)
              </button>
            )}
            {!isLLMConfigured && (
              <button
                onClick={() => setGlobalView({ name: 'settings' })}
                className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
              >
                <Settings className="size-3" />
                Configure LLM API key
              </button>
            )}
          </div>
        )}

        {/* Chrome AI status banner — only when Chrome backend is selected and not ready */}
        {usingChrome && chromeAi.status === 'downloadable' && (
          <div className="border rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <Cpu className="size-3 text-primary" />
              Gemini Nano not downloaded
            </div>
            <p className="text-[11px] text-muted-foreground">
              Chrome's on-device model needs to download first (~4 GB).
            </p>
            <Button size="sm" variant="outline" onClick={chromeAi.startDownload} className="cursor-pointer h-7 text-[11px]">
              <Download className="size-3" />
              Download model
            </Button>
          </div>
        )}
        {usingChrome && chromeAi.status === 'downloading' && (
          <div className="border rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <Spinner className="size-3" />
              Downloading Gemini Nano
              {typeof chromeAi.downloadProgress === 'number'
                ? ` (${Math.round(chromeAi.downloadProgress * 100)}%)`
                : '...'}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Analysis is paused until the download finishes. You can keep this tab open.
            </p>
          </div>
        )}
        {usingChrome && chromeAi.status === 'unavailable' && (
          <div className="border border-destructive/50 rounded-lg p-3 bg-destructive/5 space-y-1">
            <p className="text-xs font-medium text-destructive">Chrome built-in AI is not available</p>
            <p className="text-[11px] text-muted-foreground">
              Switch backend to Cloud, or enable the Prompt API at{' '}
              <code className="text-[10px]">chrome://flags/#prompt-api-for-gemini-nano</code>.
            </p>
          </div>
        )}

        {/* Hydrating — brief flash while loading the active tab's state */}
        {isHydrating && (
          <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs mt-4">
            <Spinner className="size-3" />
            Loading…
          </div>
        )}

        {/* Action buttons */}
        {!isHydrating && (
        <div className="flex gap-2">
          {!job && !report && (
            <Button
              onClick={canAnalyze ? handleExtractAndAnalyze : handleExtract}
              disabled={isWorking}
              className="flex-1 cursor-pointer"
              size="sm"
            >
              {status === 'extracting' ? (
                <>
                  <Spinner className="size-3" />
                  Extracting...
                </>
              ) : canAnalyze ? (
                <>
                  <Zap className="size-3" />
                  Extract & Analyze
                </>
              ) : (
                <>
                  <Search className="size-3" />
                  Extract JD
                </>
              )}
            </Button>
          )}

          {job && !report && status !== 'error' && (
            status === 'analyzing' ? (
              <Button
                onClick={stop}
                variant="outline"
                className="flex-1 cursor-pointer"
                size="sm"
              >
                <Square className="size-3" />
                Stop
              </Button>
            ) : (
              <>
                <Button
                  onClick={handleAnalyze}
                  disabled={!canAnalyze || isWorking}
                  className="flex-1 cursor-pointer"
                  size="sm"
                >
                  <Zap className="size-3" />
                  Analyze
                </Button>
                <Button
                  onClick={handleExtract}
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                >
                  <RefreshCw className="size-3" />
                </Button>
              </>
            )
          )}

          {status === 'error' && (
            <>
              <Button
                onClick={handleAnalyze}
                disabled={!canAnalyze || isWorking}
                className="flex-1 cursor-pointer"
                size="sm"
              >
                <Zap className="size-3" />
                Analyze
              </Button>
              <Button
                onClick={() => {
                  reset()
                  resetResume()
                }}
                variant="outline"
                className="flex-1 cursor-pointer"
                size="sm"
              >
                <RefreshCw className="size-3" />
                New Analysis
              </Button>
            </>
          )}

          {report && (
            <>
              <Button
                onClick={() => {
                  reset()
                  resetResume()
                }}
                variant="outline"
                className="flex-1 cursor-pointer"
                size="sm"
              >
                <RefreshCw className="size-3" />
                New Analysis
              </Button>
              <Button
                onClick={handleGenerateResume}
                className="flex-1 cursor-pointer"
                size="sm"
              >
                <FileText className="size-3" />
                {resumeMarkdown ? 'View Resume' : 'Generate Resume'}
              </Button>
            </>
          )}
        </div>
        )}

        {/* Error */}
        {!isHydrating && error && (
          <div className="border border-destructive/50 rounded-lg p-3 bg-destructive/5">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {/* Job summary */}
        {!isHydrating && job && <JobSummaryCard job={job} />}

        {/* Analysis results */}
        {!isHydrating && (
          <AnalysisReport
            report={report}
            progress={progress}
            analyzing={status === 'analyzing'}
            job={job}
            qnaHistory={qnaHistory}
            chatLoading={chatLoading}
            currentTabId={activeTabId!}
            useChromeBackend={usingChrome}
            profile={profile}
            customPrompt={activeCustomPrompt}
            onAppendChat={appendChatTurns}
            onSetChatLoading={setChatLoading}
            onBumpChatNonce={bumpChatNonce}
            onDeleteChatTurn={deleteChatTurn}
          />
        )}

        {/* Empty state */}
        {!job && !report && !error && !isWorking && !isHydrating && !profileLoading && (
          <div className="text-center text-muted-foreground text-sm mt-4">
            <Briefcase className="size-12 mx-auto mb-3 opacity-20" />
            <p className="font-medium">Ready to analyze</p>
            <p className="text-xs mt-1">
              Navigate to a LinkedIn job posting and click Extract
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
