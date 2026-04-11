import { Briefcase, FileText, History, RefreshCw, Search, Settings, Square, User, Zap } from 'lucide-react'
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
import { useProfile } from '@/hooks/useProfile'
import { useTabSessions } from '@/hooks/useTabSessions'
import { saveAnalysis } from '@/lib/db'
import type { AggregatedReport } from '@/types/evaluation'

function formatAnalysisContext(report: AggregatedReport): string {
  const lines: string[] = []
  lines.push(`Verdict: ${report.verdict} (score ${report.overall_score}/100)`)
  lines.push(`Overall reasoning: ${report.reasoning}`)

  const jf = report.evaluators.job_fit.result
  if (jf) {
    lines.push(`Job fit — overall: ${Math.round(jf.overall_fit * 100)}%, skill match: ${Math.round(jf.skill_match * 100)}%, experience match: ${Math.round(jf.experience_match * 100)}%`)
    if (jf.matching_skills.length) lines.push(`Matching skills: ${jf.matching_skills.join(', ')}`)
    if (jf.strengths.length) lines.push(`Strengths: ${jf.strengths.join(', ')}`)
    if (jf.gaps.length) lines.push(`Gaps: ${jf.gaps.join(', ')}`)
  }

  const risk = report.evaluators.risk.result
  if (risk) {
    lines.push(`Risk: ${risk.overall_risk} — ${risk.summary}`)
    for (const f of risk.flags) {
      if (f.severity !== 'low') lines.push(`  Risk flag (${f.severity}): ${f.description}`)
    }
  }

  const growth = report.evaluators.growth.result
  if (growth) {
    if (growth.highlights.length) lines.push(`Growth highlights: ${growth.highlights.join(', ')}`)
    if (growth.concerns.length) lines.push(`Growth concerns: ${growth.concerns.join(', ')}`)
  }

  if (report.key_risks.length) lines.push(`Key risks: ${report.key_risks.join('; ')}`)

  return lines.join('\n')
}

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
    customPrompt,
    loading: profileLoading,
    isProfileComplete,
    isLLMConfigured,
    updateProfile,
    updateLLMConfig,
    updateCustomPrompt,
  } = useProfile()

  const { activeTabId, onTabRemoved } = useActiveTab()

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
    resumeStatus,
    resumeMarkdown,
    resumeError,
    generateResume,
    regenerateResume,
    setResumeMarkdown,
    resetResume,
  } = useTabSessions(activeTabId, onTabRemoved)

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
    generateResume(job, report ? formatAnalysisContext(report) : undefined)
  }, [job, report, generateResume, setTabView])

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
        customPrompt={customPrompt}
        onSaveLLM={updateLLMConfig}
        onSavePrompt={updateCustomPrompt}
        onBack={() => setGlobalView(null)}
      />
    )
  }

  if (globalView?.name === 'history') {
    return (
      <HistoryList
        onSelect={(id) => setGlobalView({ name: 'history-detail', analysisId: id })}
        onBack={() => setGlobalView(null)}
      />
    )
  }

  if (globalView?.name === 'history-detail') {
    return (
      <HistoryDetail
        analysisId={globalView.analysisId}
        onBack={() => setGlobalView({ name: 'history' })}
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
        onBack={() => {
          resetResume()
          setTabView({ name: 'main' })
        }}
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

          {job && !report && (
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

          {(report || status === 'error') && (
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
              {report && (
                <Button
                  onClick={handleGenerateResume}
                  className="flex-1 cursor-pointer"
                  size="sm"
                >
                  <FileText className="size-3" />
                  Generate Resume
                </Button>
              )}
            </>
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
