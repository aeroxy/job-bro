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
import { buildSharedPrefix } from '@/lib/llm-client'
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
  const sharedPrefix = buildSharedPrefix(customPrompt, profile, jobMarkdown)

  // Phase 1: Run job_fit first to warm the prompt cache
  const jobFit = await runWithTracking<JobFitResult>('job_fit', () =>
    runJobFitEvaluator(sharedPrefix, config, signal)
  , onProgress)

  // Phase 2: Remaining evaluators in parallel (cache is warm)
  const [salary, preference, risk, growth] = await Promise.all([
    runWithTracking<SalaryResult>('salary', () =>
      runSalaryEvaluator(sharedPrefix, config, signal)
    , onProgress),
    runWithTracking<PreferenceResult>('preference', () =>
      runPreferenceEvaluator(sharedPrefix, config, signal)
    , onProgress),
    runWithTracking<RiskResult>('risk', () =>
      runRiskEvaluator(sharedPrefix, config, signal)
    , onProgress),
    runWithTracking<GrowthResult>('growth', () =>
      runGrowthEvaluator(sharedPrefix, config, signal)
    , onProgress),
  ])

  const evaluators = { job_fit: jobFit, salary, preference, risk, growth }

  // Phase 3: LLM-generated summary (falls back to concat on failure)
  const score = getScore(evaluators)
  const verdict = getVerdict(score, evaluators)

  let reasoning: string | undefined
  let job_summary: string | undefined
  try {
    onProgress?.('summary', 'running')
    const summary = await runSummaryEvaluator(sharedPrefix, config, evaluators, score, verdict, signal)
    reasoning = summary.reasoning
    job_summary = summary.job_summary
    onProgress?.('summary', 'completed')
  } catch {
    onProgress?.('summary', 'error')
  }

  return aggregate(job, evaluators, reasoning, job_summary)
}
