import { Briefcase, History, RefreshCw, Search, Settings, User, Zap } from 'lucide-react'
import { useCallback, useState } from 'react'

import { AnalysisReport } from '@/components/AnalysisReport'
import { HistoryDetail } from '@/components/HistoryDetail'
import { HistoryList } from '@/components/HistoryList'
import { JobSummaryCard } from '@/components/JobSummaryCard'
import { ProfileForm } from '@/components/ProfileForm'
import { SettingsForm } from '@/components/SettingsForm'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAnalysis } from '@/hooks/useAnalysis'
import { useProfile } from '@/hooks/useProfile'
import { saveAnalysis } from '@/lib/db'

type View =
  | { name: 'main' }
  | { name: 'profile' }
  | { name: 'settings' }
  | { name: 'history' }
  | { name: 'history-detail'; analysisId: string }

export default function App() {
  const [view, setView] = useState<View>({ name: 'main' })

  const {
    profile,
    llmConfig,
    customPrompt,
    loading: profileLoading,
    isProfileComplete,
    isLLMConfigured,
    updateProfile,
    updateLLMConfig,
    updateCustomPrompt,
  } = useProfile()

  const {
    status,
    job,
    report,
    error,
    progress,
    extract,
    analyze,
    reset,
  } = useAnalysis()

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

  // --- View routing ---

  if (view.name === 'profile') {
    return (
      <ProfileForm
        profile={profile}
        onSave={updateProfile}
        onBack={() => setView({ name: 'main' })}
      />
    )
  }

  if (view.name === 'settings') {
    return (
      <SettingsForm
        llmConfig={llmConfig}
        customPrompt={customPrompt}
        onSaveLLM={updateLLMConfig}
        onSavePrompt={updateCustomPrompt}
        onBack={() => setView({ name: 'main' })}
      />
    )
  }

  if (view.name === 'history') {
    return (
      <HistoryList
        onSelect={(id) => setView({ name: 'history-detail', analysisId: id })}
        onBack={() => setView({ name: 'main' })}
      />
    )
  }

  if (view.name === 'history-detail') {
    return (
      <HistoryDetail
        analysisId={view.analysisId}
        onBack={() => setView({ name: 'history' })}
      />
    )
  }

  // --- Main view ---

  const isWorking = status === 'extracting' || status === 'analyzing'
  const canAnalyze = isProfileComplete && isLLMConfigured
  const showSetupHints = !isProfileComplete || !isLLMConfigured

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Briefcase className="size-5 text-primary" />
          <span className="text-sm font-medium">Job Bro</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setView({ name: 'profile' })}
            className="cursor-pointer"
          >
            <User className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setView({ name: 'history' })}
            className="cursor-pointer"
          >
            <History className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setView({ name: 'settings' })}
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
                onClick={() => setView({ name: 'profile' })}
                className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
              >
                <User className="size-3" />
                Set up your profile (resume, salary, preferences)
              </button>
            )}
            {!isLLMConfigured && (
              <button
                onClick={() => setView({ name: 'settings' })}
                className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
              >
                <Settings className="size-3" />
                Configure LLM API key
              </button>
            )}
          </div>
        )}

        {/* Action buttons */}
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

          {job && !report && !isWorking && (
            <>
              <Button
                onClick={handleAnalyze}
                disabled={!canAnalyze || isWorking}
                className="flex-1 cursor-pointer"
                size="sm"
              >
                {status === 'analyzing' ? (
                  <>
                    <Spinner className="size-3" />
                    Analyzing...
                  </>
                ) : (
                  <>
                    <Zap className="size-3" />
                    Analyze
                  </>
                )}
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
          )}

          {status === 'analyzing' && (
            <Button disabled className="flex-1" size="sm">
              <Spinner className="size-3" />
              Analyzing...
            </Button>
          )}

          {(report || status === 'error') && (
            <Button
              onClick={() => {
                reset()
              }}
              variant="outline"
              className="flex-1 cursor-pointer"
              size="sm"
            >
              <RefreshCw className="size-3" />
              New Analysis
            </Button>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="border border-destructive/50 rounded-lg p-3 bg-destructive/5">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {/* Job summary */}
        {job && <JobSummaryCard job={job} />}

        {/* Analysis results */}
        <AnalysisReport
          report={report}
          progress={progress}
          analyzing={status === 'analyzing'}
        />

        {/* Empty state */}
        {!job && !report && !error && !isWorking && !profileLoading && (
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
