import type {
  AggregatedReport,
  EvaluatorStatus,
  GrowthResult,
  JobFitResult,
  PreferenceResult,
  RiskResult,
  SalaryResult,
} from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'
import type { LLMConfig, UserProfile } from '@/types/profile'

import { runGrowthEvaluator } from './growth'
import { runJobFitEvaluator } from './job-fit'
import { runPreferenceEvaluator } from './preference'
import { runRiskEvaluator } from './risk'
import { runSalaryEvaluator } from './salary'
import { runSummaryEvaluator } from './summary'
import { aggregate, getScore, getVerdict } from './aggregator'
import { jobToMarkdown } from '@/extractor/markdown'

type ProgressCallback = (evaluator: string, status: 'running' | 'completed' | 'error') => void

async function runWithTracking<T>(
  name: string,
  fn: () => Promise<T>,
  onProgress?: ProgressCallback
): Promise<EvaluatorStatus<T>> {
  onProgress?.(name, 'running')
  try {
    const result = await fn()
    onProgress?.(name, 'completed')
    return { status: 'fulfilled', result }
  } catch (e) {
    onProgress?.(name, 'error')
    return { status: 'rejected', error: (e as Error).message }
  }
}

export async function runAllEvaluators(
  job: ExtractedJob,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt?: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<AggregatedReport> {
  const jobMarkdown = jobToMarkdown(job)

  // All evaluators run in parallel — each builds its own focused context
  const [jobFit, salary, preference, risk, growth] = await Promise.all([
    runWithTracking<JobFitResult>('job_fit', () =>
      runJobFitEvaluator(jobMarkdown, profile, config, customPrompt, signal)
    , onProgress),
    runWithTracking<SalaryResult>('salary', () =>
      runSalaryEvaluator(jobMarkdown, profile, config, customPrompt, signal)
    , onProgress),
    runWithTracking<PreferenceResult>('preference', () =>
      runPreferenceEvaluator(jobMarkdown, profile, config, customPrompt, signal)
    , onProgress),
    runWithTracking<RiskResult>('risk', () =>
      runRiskEvaluator(jobMarkdown, profile, config, customPrompt, signal)
    , onProgress),
    runWithTracking<GrowthResult>('growth', () =>
      runGrowthEvaluator(jobMarkdown, profile, config, customPrompt, signal)
    , onProgress),
  ])

  const evaluators = { job_fit: jobFit, salary, preference, risk, growth }

  // Summary runs after — it depends on all evaluator results
  const score = getScore(evaluators)
  const verdict = getVerdict(score, evaluators)

  onProgress?.('summary', 'running')
  const summary = await runSummaryEvaluator(jobMarkdown, evaluators, score, verdict, config, customPrompt, signal)
  onProgress?.('summary', 'completed')

  return aggregate(job, evaluators, summary.reasoning, summary.job_summary)
}
