import {
  AlertTriangle,
  Banknote,
  BookOpen,
  ExternalLink,
  Heart,
  Lightbulb,
  RotateCw,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react'
import { marked } from 'marked'
import { useMemo } from 'react'

import type { AggregatedReport, EvidenceItem, EvaluatorStatus } from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'
import type { ChatTurn } from '@/types/chat'
import type { UserProfile } from '@/types/profile'
import type { EvaluatorProgress, EvaluatorActivity, PartialEvaluatorResults } from '@/hooks/useTabSessions'
import { formatAnalysisContext } from '@/lib/analysis-context'
import { jobToMarkdown } from '@/extractor/markdown'
import { EvaluatorCard } from './EvaluatorCard'
import { ReportChat } from './ReportChat'
import { ScoreBar } from './ScoreBar'
import { StatusPill } from './StatusPill'
import { VerdictBadge } from './VerdictBadge'

interface AnalysisReportProps {
  report: AggregatedReport | null
  progress: EvaluatorProgress
  analyzing: boolean
  job?: ExtractedJob | null
  qnaHistory?: ChatTurn[]
  chatLoading?: boolean
  currentTabId?: number
  useChromeBackend?: boolean
  profile?: UserProfile
  customPrompt?: string
  activity?: EvaluatorActivity
  // Per-evaluator results streamed in as each finishes. Falls back to
  // report.evaluators so the body of each card renders the moment that
  // evaluator lands — no more empty dropdown while waiting for the
  // aggregator to bundle all 5 +summary.
  evaluatorResults?: PartialEvaluatorResults
  onAppendChat?: (turns: ChatTurn[], targetTabId: number, nonce?: number) => void
  onSetChatLoading?: (tabId: number, loading: boolean, nonce?: number) => void
  onBumpChatNonce?: (tabId: number) => number
  onDeleteChatTurn?: (index: number) => void
  // Resume a partially-failed run: re-runs the failed evaluators + their
  // dependents. Surfaced via the Continue banner when the run settled with
  // any errored/blocked evaluator.
  onContinue?: () => void
}

export function AnalysisReport({ report, progress, analyzing, job, qnaHistory, chatLoading, currentTabId, useChromeBackend, profile, customPrompt, activity, evaluatorResults, onAppendChat, onSetChatLoading, onBumpChatNonce, onDeleteChatTurn, onContinue }: AnalysisReportProps) {
  const jobMarkdown = useMemo(() => (job ? jobToMarkdown(job) : ''), [job])
  const analysisContext = useMemo(() => (report ? formatAnalysisContext(report) : ''), [report])

  // No analysis run yet, or done with no report — nothing to render.
  if (!report && !analyzing) return null

  // Resolve the result for a given evaluator slot. Prefers the streamed
  // partial (so the body shows up the moment that evaluator finishes, not
  // after the aggregator bundles everything) and falls back to the
  // aggregated report. Returns undefined if neither source has it.
  const resultFor = <K extends keyof PartialEvaluatorResults>(slot: K): PartialEvaluatorResults[K] | undefined => {
    // 'summary' only ever comes from the streamed partials — report.evaluators
    // has no summary slot (the aggregator computes verdict/score separately).
    if (slot === 'summary') {
      return evaluatorResults?.summary as PartialEvaluatorResults[K] | undefined
    }
    const key = slot as 'job_fit' | 'salary' | 'preference' | 'risk' | 'growth'
    return evaluatorResults?.[slot] ?? report?.evaluators[key]?.result as PartialEvaluatorResults[K] | undefined
  }

  // Are we still waiting for this evaluator's content? The card is
  // non-expandable while waiting — opening it would show an empty body.
  // "Waiting" means: progress says completed (so the card is otherwise
  // ready to expand) but neither the streamed partial nor the aggregated
  // report has a result yet. That gap is normally tiny (status and result
  // messages are sent back-to-back) but it can be visible if messages
  // arrive out of order or during the first-frame race.
  const waitingFor = (status: EvaluatorStatus<unknown> | undefined, partial: unknown) =>
    !status
      ? !partial
      : status.status !== 'fulfilled' || (!status.result && !partial)

  // Failure reason for an evaluator slot, if it rejected. Lives on the
  // aggregated report's EvaluatorStatus.error (set by runner.runWithTracking).
  const errorFor = (slot: 'job_fit' | 'salary' | 'preference' | 'risk' | 'growth'): string | undefined => {
    const s = report?.evaluators[slot]
    return s?.status === 'rejected' ? s.error : undefined
  }

  // The run has settled with at least one evaluator failed or blocked — offer
  // a Continue that re-runs the failed evaluators + everything depending on
  // them (reusing the successful results).
  const failedEvaluators = Object.values(progress).filter((s) => s === 'error' || s === 'blocked').length
  const summaryOnly = failedEvaluators === 1 && progress.summary === 'error'
  const canContinue =
    !analyzing &&
    !!onContinue &&
    failedEvaluators > 0

  return (
    <div className="space-y-3">
      {canContinue && (
        <div className="border border-amber-500/50 bg-amber-50/60 dark:bg-amber-900/20 rounded-lg p-3 flex items-center justify-between gap-3">
          <div className="flex items-start gap-2 min-w-0">
            <AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-800 dark:text-amber-200">
              {summaryOnly
                ? 'Summary generation failed. Continue to retry it.'
                : 'An evaluator failed, so the steps depending on it were skipped. Continue to re-run them.'}
            </p>
          </div>
          <button
            onClick={onContinue}
            className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md bg-amber-600 text-white hover:bg-amber-700 transition-colors cursor-pointer"
          >
            <RotateCw className="size-3" />
            Continue
          </button>
        </div>
      )}
      {/* Summary (synthesizes verdict + job_summary + reasoning once all
          5 evaluators are done). Has its own status pill — runs last. */}
      <SummaryCard
        status={progress.summary}
        report={report}
        summary={resultFor('summary')}
      />

      {/* Evaluator Cards */}
      <div className="space-y-2">
        <EvaluatorCard
          title="Job Fit"
          icon={<Target className="size-3.5" />}
          status={progress.job_fit}
          activity={activity?.job_fit}
          error={errorFor('job_fit')}
          waitingForContent={waitingFor(report?.evaluators.job_fit as EvaluatorStatus<unknown>, evaluatorResults?.job_fit)}
        >
          {resultFor('job_fit') && (
            <JobFitDetail result={resultFor('job_fit')!} />
          )}
        </EvaluatorCard>

        <EvaluatorCard
          title="Salary"
          icon={<Banknote className="size-3.5" />}
          status={progress.salary}
          activity={activity?.salary}
          error={errorFor('salary')}
          waitingForContent={waitingFor(report?.evaluators.salary as EvaluatorStatus<unknown>, evaluatorResults?.salary)}
        >
          {resultFor('salary') && (
            <SalaryDetail result={resultFor('salary')!} />
          )}
        </EvaluatorCard>

        <EvaluatorCard
          title="Preferences"
          icon={<Heart className="size-3.5" />}
          status={progress.preference}
          activity={activity?.preference}
          error={errorFor('preference')}
          waitingForContent={waitingFor(report?.evaluators.preference as EvaluatorStatus<unknown>, evaluatorResults?.preference)}
        >
          {resultFor('preference') && (
            <PreferenceDetail result={resultFor('preference')!} />
          )}
        </EvaluatorCard>

        <EvaluatorCard
          title="Risk"
          icon={<AlertTriangle className="size-3.5" />}
          status={progress.risk}
          activity={activity?.risk}
          error={errorFor('risk')}
          waitingForContent={waitingFor(report?.evaluators.risk as EvaluatorStatus<unknown>, evaluatorResults?.risk)}
        >
          {resultFor('risk') && (
            <RiskDetail result={resultFor('risk')!} />
          )}
        </EvaluatorCard>

        <EvaluatorCard
          title="Growth"
          icon={<TrendingUp className="size-3.5" />}
          status={progress.growth}
          activity={activity?.growth}
          error={errorFor('growth')}
          waitingForContent={waitingFor(report?.evaluators.growth as EvaluatorStatus<unknown>, evaluatorResults?.growth)}
        >
          {resultFor('growth') && (
            <GrowthDetail result={resultFor('growth')!} />
          )}
        </EvaluatorCard>
      </div>

      {/* Key Risks */}
      {report && (report.key_risks?.length ?? 0) > 0 && (
        <div className="border rounded-lg p-3 space-y-1.5">
          <h4 className="text-xs font-semibold flex items-center gap-1.5">
            <AlertTriangle className="size-3 text-destructive" />
            Key Risks
          </h4>
          <ul className="space-y-1">
            {report.key_risks.map((risk, i) => (
              <li key={i} className="text-xs text-muted-foreground flex gap-1.5">
                <span className="text-destructive mt-0.5">-</span>
                {risk}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Negotiation Tips */}
      {report && (report.negotiation_tips?.length ?? 0) > 0 && (
        <div className="border rounded-lg p-3 space-y-1.5">
          <h4 className="text-xs font-semibold flex items-center gap-1.5">
            <Lightbulb className="size-3 text-yellow-500" />
            Negotiation Tips
          </h4>
          <ul className="space-y-1">
            {report.negotiation_tips.map((tip, i) => (
              <li key={i} className="text-xs text-muted-foreground flex gap-1.5">
                <span className="text-yellow-500 mt-0.5">-</span>
                {tip}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* References (deduplicated across all evaluators) */}
      {report && (report.references?.length ?? 0) > 0 && (
        <ReferencesSection references={report.references} />
      )}

      {/* Chat */}
      {report && job && qnaHistory !== undefined && chatLoading !== undefined && currentTabId !== undefined && onAppendChat && onSetChatLoading && onBumpChatNonce && onDeleteChatTurn && (
        <ReportChat
          jobMarkdown={jobMarkdown}
          analysisContext={analysisContext}
          history={qnaHistory}
          loading={chatLoading}
          currentTabId={currentTabId}
          useChromeBackend={useChromeBackend}
          profile={profile}
          customPrompt={customPrompt}
          onAppend={onAppendChat}
          onSetLoading={onSetChatLoading}
          onBumpNonce={onBumpChatNonce}
          onDeleteTurn={onDeleteChatTurn}
        />
      )}
    </div>
  )
}

// --- Summary card ---

// Verdict + job_summary + reasoning. Has its own status pill driven by
// `progress.summary` so the user sees "Synthesizing..." while the summary
// evaluator is running (it goes last, after all 5 research evaluators).
// Body renders as soon as EITHER the streamed summary partial lands or the
// full aggregated report is available. The streamed partial doesn't have
// verdict/overall_score (those are computed by the aggregator), so when
// only the partial is in we render the text but skip the verdict badge.
function SummaryCard({
  status,
  report,
  summary,
}: {
  status: EvaluatorProgress['summary']
  report: AggregatedReport | null
  summary?: { job_summary: string; reasoning: string }
}) {
  return (
    <div className="border rounded-lg">
      <div className="w-full flex items-center px-3 py-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Sparkles className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Summary</span>
          <StatusPill
            status={status}
            customLabel={{ running: 'Synthesizing…', queued: 'Waiting…', done: 'Done', failed: 'Failed' }}
          />
        </div>
      </div>
      {report && (
        <div className="px-3 pb-3 pt-1 border-t space-y-2">
          <VerdictBadge verdict={report.verdict} score={report.overall_score} />
          {report.job_summary && (
            <p className="text-xs leading-relaxed">{report.job_summary}</p>
          )}
          <p className="text-xs text-muted-foreground leading-relaxed">{report.reasoning}</p>
        </div>
      )}
      {!report && summary && (
        <div className="px-3 pb-3 pt-1 border-t space-y-2">
          {summary.job_summary && (
            <p className="text-xs leading-relaxed">{summary.job_summary}</p>
          )}
          <p className="text-xs text-muted-foreground leading-relaxed">{summary.reasoning}</p>
          <p className="text-[10px] text-muted-foreground/70">Final verdict will appear once all evaluators complete…</p>
        </div>
      )}
    </div>
  )
}

// --- Sub-components for each evaluator ---

// Safely coerce any value to a renderable string
function str(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

function arr<T>(v: T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : []
}

// Only http(s) links are safe to render as clickable anchors. Evidence URLs
// come from LLM output (which reads attacker-influenced pages), so a crafted
// javascript:/data: URL must never become an executable link.
function safeHttpUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

function ReferencesSection({ references }: { references: EvidenceItem[] }) {
  return (
    <div className="border rounded-lg p-3 space-y-1.5">
      <h4 className="text-xs font-semibold flex items-center gap-1.5">
        <BookOpen className="size-3 text-blue-500" />
        References ({references.length})
      </h4>
      <ul className="space-y-1.5">
        {references.map((ref, i) => {
          const safeUrl = safeHttpUrl(ref.url)
          return (
          <li key={i} className="text-xs space-y-0.5">
            {safeUrl ? (
              <a
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1 break-all"
              >
                {ref.title || ref.url}
                <ExternalLink className="size-2.5 shrink-0" />
              </a>
            ) : (
              <span className="break-all">{ref.title || ref.url}</span>
            )}
            {ref.snippet && (
              <p className="text-muted-foreground line-clamp-2">{ref.snippet}</p>
            )}
            {ref.cited_by && ref.cited_by.length > 0 && (
              <p className="text-[10px] text-muted-foreground/70">
                cited by {ref.cited_by.join(', ').replace(/_/g, ' ')}
              </p>
            )}
          </li>
          )
        })}
      </ul>
    </div>
  )
}

function JobFitDetail({ result }: { result: import('@/types/evaluation').JobFitResult }) {
  const gaps = arr(result.gaps)
  const strengths = arr(result.strengths)
  return (
    <div className="space-y-2 pt-1">
      <ScoreBar label="Skill Match" value={result.skill_match} />
      <ScoreBar label="Experience Match" value={result.experience_match} />
      <ScoreBar label="Overall Fit" value={result.overall_fit} />
      <p className="text-xs text-muted-foreground">{str(result.summary)}</p>
      {gaps.length > 0 && (
        <div>
          <span className="text-[10px] uppercase text-muted-foreground font-medium">Gaps</span>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {gaps.map((g, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                {str(g)}
              </span>
            ))}
          </div>
        </div>
      )}
      {strengths.length > 0 && (
        <div>
          <span className="text-[10px] uppercase text-muted-foreground font-medium">Strengths</span>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {strengths.map((s, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                {str(s)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SalaryDetail({ result }: { result: import('@/types/evaluation').SalaryResult }) {
  const alignmentColor: Record<string, string> = {
    below: 'text-red-600 dark:text-red-400',
    within: 'text-green-600 dark:text-green-400',
    above: 'text-yellow-600 dark:text-yellow-400',
  }
  const range = result.estimated_range
  const hasRange = range && typeof range.min === 'number' && typeof range.max === 'number'

  return (
    <div className="space-y-1.5 pt-1">
      {hasRange && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Estimated Range</span>
          <span className="font-medium">
            ${range.min.toLocaleString()} – ${range.max.toLocaleString()} {str(range.currency)}
          </span>
        </div>
      )}
      {result.expectation_alignment && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Alignment</span>
          <span className={`font-medium capitalize ${alignmentColor[result.expectation_alignment] ?? ''}`}>
            {str(result.expectation_alignment)}
          </span>
        </div>
      )}
      {result.risk_flag && (
        <div className="text-xs text-destructive flex items-center gap-1">
          <AlertTriangle className="size-3" />
          Salary risk detected
        </div>
      )}
      <p className="text-xs text-muted-foreground">{str(result.reasoning)}</p>
    </div>
  )
}

function PreferenceDetail({ result }: { result: import('@/types/evaluation').PreferenceResult }) {
  const summaryHtml = result.summary
    ? marked.parse(result.summary, { async: false }) as string
    : ''
  return (
    <div className="space-y-1.5 pt-1">
      <ScoreBar label="Alignment" value={result.alignment_score} />
      {summaryHtml
        ? <div className="pref-summary text-xs text-muted-foreground" dangerouslySetInnerHTML={{ __html: summaryHtml }} />
        : <p className="text-xs text-muted-foreground">{str(result.summary)}</p>
      }
    </div>
  )
}

function RiskDetail({ result }: { result: import('@/types/evaluation').RiskResult }) {
  const riskColor: Record<string, string> = {
    low: 'text-green-600 dark:text-green-400',
    medium: 'text-yellow-600 dark:text-yellow-400',
    high: 'text-red-600 dark:text-red-400',
  }
  const flags = arr(result.flags).filter((f) => f && str(f.description).trim().length > 0)

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Overall Risk</span>
        <span className={`font-medium uppercase ${riskColor[result.overall_risk] ?? ''}`}>
          {str(result.overall_risk)}
        </span>
      </div>
      {flags.length > 0 && (
        <div className="space-y-1">
          {flags.map((f, i) => (
            <div key={i} className="text-xs flex items-start gap-1.5">
              <span
                className={`mt-0.5 inline-block size-1.5 rounded-full shrink-0 ${
                  f.severity === 'high' ? 'bg-red-500' : f.severity === 'medium' ? 'bg-yellow-500' : 'bg-muted-foreground'
                }`}
              />
              <span className="text-muted-foreground">{str(f.description)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{str(result.summary)}</p>
    </div>
  )
}

function GrowthDetail({ result }: { result: import('@/types/evaluation').GrowthResult }) {
  const highlights = arr(result.highlights)
  const concerns = arr(result.concerns)
  return (
    <div className="space-y-2 pt-1">
      <ScoreBar label="Learning" value={result.learning_opportunity} />
      <ScoreBar label="Brand Value" value={result.brand_value} />
      <ScoreBar label="Career Path" value={result.career_trajectory} />
      <ScoreBar label="Overall Growth" value={result.overall_growth} />
      <p className="text-xs text-muted-foreground">{str(result.summary)}</p>
      {highlights.length > 0 && (
        <div>
          <span className="text-[10px] uppercase text-muted-foreground font-medium">Highlights</span>
          <ul className="mt-0.5 space-y-0.5">
            {highlights.map((h, i) => (
              <li key={i} className="text-xs text-muted-foreground flex gap-1">
                <span className="text-green-500">+</span>{str(h)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {concerns.length > 0 && (
        <div>
          <span className="text-[10px] uppercase text-muted-foreground font-medium">Concerns</span>
          <ul className="mt-0.5 space-y-0.5">
            {concerns.map((c, i) => (
              <li key={i} className="text-xs text-muted-foreground flex gap-1">
                <span className="text-yellow-500">-</span>{str(c)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
