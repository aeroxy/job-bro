import {
  AlertTriangle,
  BarChart3,
  Banknote,
  Heart,
  Lightbulb,
  Target,
  TrendingUp,
} from 'lucide-react'
import { marked } from 'marked'

import type { AggregatedReport } from '@/types/evaluation'
import type { EvaluatorProgress } from '@/hooks/useTabSessions'
import { EvaluatorCard } from './EvaluatorCard'
import { ScoreBar } from './ScoreBar'
import { VerdictBadge } from './VerdictBadge'

interface AnalysisReportProps {
  report: AggregatedReport | null
  progress: EvaluatorProgress
  analyzing: boolean
}

export function AnalysisReport({ report, progress, analyzing }: AnalysisReportProps) {
  if (!report && !analyzing) return null

  return (
    <div className="space-y-3">
      {/* Verdict */}
      {report ? (
        <div className="border rounded-lg p-3 space-y-2">
          <VerdictBadge verdict={report.verdict} score={report.overall_score} />
          {report.job_summary && (
            <p className="text-xs leading-relaxed">{report.job_summary}</p>
          )}
          <p className="text-xs text-muted-foreground leading-relaxed">{report.reasoning}</p>
        </div>
      ) : progress.summary === 'running' && (
        <div className="border rounded-lg p-3 space-y-2 animate-pulse">
          <div className="h-5 w-24 rounded bg-muted" />
          <div className="space-y-1.5">
            <div className="h-3 rounded bg-muted" />
            <div className="h-3 w-4/5 rounded bg-muted" />
          </div>
        </div>
      )}

      {/* Evaluator Cards */}
      <div className="space-y-2">
        <EvaluatorCard
          title="Job Fit"
          icon={<Target className="size-3.5" />}
          status={progress.job_fit}
          error={report?.evaluators.job_fit.error}
        >
          {report?.evaluators.job_fit.result && (
            <JobFitDetail result={report.evaluators.job_fit.result} />
          )}
        </EvaluatorCard>

        <EvaluatorCard
          title="Salary"
          icon={<Banknote className="size-3.5" />}
          status={progress.salary}
          error={report?.evaluators.salary.error}
        >
          {report?.evaluators.salary.result && (
            <SalaryDetail result={report.evaluators.salary.result} />
          )}
        </EvaluatorCard>

        <EvaluatorCard
          title="Preferences"
          icon={<Heart className="size-3.5" />}
          status={progress.preference}
          error={report?.evaluators.preference.error}
        >
          {report?.evaluators.preference.result && (
            <PreferenceDetail result={report.evaluators.preference.result} />
          )}
        </EvaluatorCard>

        <EvaluatorCard
          title="Risk"
          icon={<AlertTriangle className="size-3.5" />}
          status={progress.risk}
          error={report?.evaluators.risk.error}
        >
          {report?.evaluators.risk.result && (
            <RiskDetail result={report.evaluators.risk.result} />
          )}
        </EvaluatorCard>

        <EvaluatorCard
          title="Growth"
          icon={<TrendingUp className="size-3.5" />}
          status={progress.growth}
          error={report?.evaluators.growth.error}
        >
          {report?.evaluators.growth.result && (
            <GrowthDetail result={report.evaluators.growth.result} />
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
  const flags = arr(result.flags)

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
