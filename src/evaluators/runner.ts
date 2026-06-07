import type {
  AggregatedReport,
  EvaluatorStatus,
  EvidenceItem,
  GrowthResult,
  JobFitResult,
  PreferenceResult,
  RiskResult,
  SalaryResult,
} from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'
import type { LLMConfig, UserProfile } from '@/types/profile'

import { runGrowthEvaluator, GROWTH_JSON_SCHEMA } from './growth'
import { runJobFitEvaluator, JOB_FIT_JSON_SCHEMA } from './job-fit'
import { runPreferenceEvaluator, PREFERENCE_JSON_SCHEMA } from './preference'
import { runRiskEvaluator, RISK_JSON_SCHEMA } from './risk'
import { runSalaryEvaluator, SALARY_JSON_SCHEMA } from './salary'
import { runSummaryEvaluator, SUMMARY_JSON_SCHEMA } from './summary'
import { aggregate, getScore, getVerdict } from './aggregator'
import { jobToMarkdown } from '@/extractor/markdown'
import { ALL_TOOLS } from '@/lib/tools/definitions'
import { createCachedExecutor } from '@/lib/agent'
import type { ToolCall, ToolDefinition } from '@/lib/tools/types'
import type { JsonSchemaSpec } from '@/lib/llm-client'

export type EvaluatorName = 'job_fit' | 'salary' | 'preference' | 'risk' | 'growth' | 'summary'

// Local progress signature — narrowed to what the runner actually emits. The
// hook uses a wider type that also includes 'pending' (the initial state
// before 'running'), but the runner only transitions 'running' -> 'completed'|
// 'error' so the orchestrator can stay narrow.
type ProgressCallback = (evaluator: string, status: 'running' | 'completed' | 'error' | 'blocked') => void
type ToolCallCallback = (evaluator: string, call: ToolCall) => void
// Streamed per-evaluator result. Fires once, right after the 'completed'
// status, so the sidepanel can populate each card body as soon as that
// evaluator finishes — not after all 5 +summary land in the aggregated report.
type EvaluatorResultCallback = (evaluator: string, result: unknown) => void

// Pool the `evidences` from upstream evaluators into a single deduped list to
// inject into the downstream stage. Same URL key as the aggregator's
// collectReferences (strip fragment + query, lowercase) so the two agree.
function poolEvidence(...results: Array<{ evidences?: EvidenceItem[] } | undefined>): EvidenceItem[] {
  const byUrl = new Map<string, EvidenceItem>()
  for (const r of results) {
    for (const ev of r?.evidences ?? []) {
      // url comes from untrusted LLM output — may be missing, non-string, or blank.
      if (typeof ev?.url !== 'string' || !ev.url.trim()) continue
      const key = ev.url.split('#')[0]!.split('?')[0]!.toLowerCase()
      if (!byUrl.has(key)) byUrl.set(key, ev)
    }
  }
  return Array.from(byUrl.values())
}

async function runWithTracking<T>(
  name: string,
  fn: () => Promise<T>,
  onProgress?: ProgressCallback,
  onEvaluatorResult?: EvaluatorResultCallback
): Promise<EvaluatorStatus<T>> {
  onProgress?.(name, 'running')
  try {
    const result = await fn()
    onProgress?.(name, 'completed')
    onEvaluatorResult?.(name, result)
    return { status: 'fulfilled', result }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    const errorName = e instanceof Error ? e.name : ''
    // AbortError is expected — the user stopped the analysis or the tab closed.
    // It's a cancellation, not a failure, so don't surface it as an error.
    if (errorName !== 'AbortError') {
      console.error(`[evaluator:${name}] failed:`, e)
    }
    onProgress?.(name, 'error')
    return { status: 'rejected', error: errorMessage }
  }
}

// Resolved once per run from the active config. Cloud-only: when the user
// has disabled tools for this profile (local LLM servers that don't
// support function-calling), pass an empty tools array so the agent
// loop's first response has no `tool_calls` and the loop exits after 1
// iteration. Chrome backend never receives tools regardless, so this flag
// has no effect there.
// Only the evaluators that genuinely do external research get tools. The rest
// (job_fit — pure resume-vs-JD matching; summary — synthesis of results that
// already exist) run tool-free: it saves wasted round-trips, and a tool-free
// evaluator is eligible for the strict structured-output path (resolveSchema
// gates on no-tools). The downstream synthesizers also inherit the researchers'
// findings via the injected prior-research block, so they need fewer searches.
const TOOL_EVALUATORS = new Set<EvaluatorName>(['risk', 'salary', 'growth', 'preference'])

function resolveTools(config: LLMConfig, evaluator: EvaluatorName): ToolDefinition[] {
  if (config.tools_enabled === false) return []
  return TOOL_EVALUATORS.has(evaluator) ? ALL_TOOLS : []
}

// Resolved once per run. When structured output is enabled AND the evaluator
// in question has no tools, pass its JSON Schema via
// `response_format.json_schema` — the model can't drift shape and the
// parseJSON/validate retry path is bypassed. Skipped for evaluators that
// have a non-empty tools array because strict json_schema forces the model
// to emit a JSON object on every response, blocking the tool_calls response
// shape — the agent loop's first iteration needs `tool_calls`, not content.
// Cloud providers that support OpenAI's strict json_schema format
// (OpenAI, Groq, Together, Fireworks, vLLM). Chrome backend ignores the
// schema (its own responseConstraint path is not used here). Disabled by
// default because some local LLM servers (smaller Ollama builds, llama.cpp)
// silently drop unknown response_format fields or error on them.
function resolveSchema(
  config: LLMConfig,
  spec: JsonSchemaSpec,
  tools: ToolDefinition[],
): JsonSchemaSpec | undefined {
  if (config.structured_output !== true) return undefined
  if (config.backend === 'chrome-prompt') return undefined
  if (tools.length > 0) return undefined
  return spec
}

export async function runAllEvaluators(
  job: ExtractedJob,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt: string,
  onProgress?: ProgressCallback,
  onToolCall?: ToolCallCallback,
  signal?: AbortSignal,
  onEvaluatorResult?: EvaluatorResultCallback,
  // Resume support: fulfilled results from a previous run, keyed by evaluator.
  // Reused as-is instead of re-running, so a "Continue" only re-runs the
  // failed evaluators + everything that depends on them.
  priorResults?: Partial<AggregatedReport['evaluators']>,
): Promise<AggregatedReport> {
  const jobMarkdown = jobToMarkdown(job)
  // Tools are resolved per evaluator (see TOOL_EVALUATORS); resolveSchema then
  // drops the strict schema only for the evaluators that actually carry tools.
  const jobFitTools = resolveTools(config, 'job_fit')
  const salaryTools = resolveTools(config, 'salary')
  const preferenceTools = resolveTools(config, 'preference')
  const riskTools = resolveTools(config, 'risk')
  const growthTools = resolveTools(config, 'growth')
  const summaryTools = resolveTools(config, 'summary')
  const jobFitSchema = resolveSchema(config, JOB_FIT_JSON_SCHEMA, jobFitTools)
  const salarySchema = resolveSchema(config, SALARY_JSON_SCHEMA, salaryTools)
  const preferenceSchema = resolveSchema(config, PREFERENCE_JSON_SCHEMA, preferenceTools)
  const riskSchema = resolveSchema(config, RISK_JSON_SCHEMA, riskTools)
  const growthSchema = resolveSchema(config, GROWTH_JSON_SCHEMA, growthTools)
  const summarySchema = resolveSchema(config, SUMMARY_JSON_SCHEMA, summaryTools)

  // Wrap the orchestrator-level onToolCall with the evaluator name so the UI
  // can route each event to the right card.
  const forEvaluator = (name: string) => (call: ToolCall) => onToolCall?.(name, call)

  // One cache shared across every evaluator in this run: the same company page
  // / search isn't re-fetched per evaluator, and the downstream stage (risk,
  // growth) reuses pages already fetched upstream for free.
  const exec = createCachedExecutor()

  // --- Fail-fast staged execution with resume -------------------------------
  // Each evaluator runs only once its hard dependencies have *fulfilled*. If a
  // dependency failed (or was itself blocked), the evaluator is marked
  // 'blocked' and never runs — the pipeline stops along that branch instead of
  // degrading to a JD-only fallback. `priorResults` lets a "Continue" re-run
  // reuse the successes and re-run only the failed evaluators + their dependents.
  const results: Partial<Record<EvaluatorName, EvaluatorStatus<unknown>>> = {}
  const ok = (name: EvaluatorName) => results[name]?.status === 'fulfilled'

  // Reuse a prior fulfilled result; else block when a dependency isn't
  // fulfilled; else run. Never throws (runWithTracking captures failures as a
  // 'rejected' status), so the parallel stages below settle in full — an
  // in-flight sibling isn't aborted just because its partner failed.
  async function stageRun<T>(name: EvaluatorName, deps: EvaluatorName[], fn: () => Promise<T>): Promise<void> {
    const prior = priorResults?.[name as keyof AggregatedReport['evaluators']]
    if (prior?.status === 'fulfilled') {
      results[name] = prior as EvaluatorStatus<unknown>
      onProgress?.(name, 'completed')
      onEvaluatorResult?.(name, prior.result)
      return
    }
    if (!deps.every(ok)) {
      results[name] = { status: 'blocked' }
      onProgress?.(name, 'blocked')
      return
    }
    results[name] = await runWithTracking<T>(name, fn, onProgress, onEvaluatorResult)
  }

  // Stage 1 — preference goes first to warm the LLM's KV cache (its evidence
  // also seeds the downstream prior-research pool). No dependencies.
  await stageRun('preference', [], () =>
    runPreferenceEvaluator(jobMarkdown, profile, config, customPrompt, preferenceTools, forEvaluator('preference'), signal, preferenceSchema, exec))

  // Stage 2 — independent researchers, concurrent.
  await Promise.all([
    stageRun('job_fit', [], () =>
      runJobFitEvaluator(jobMarkdown, profile, config, customPrompt, jobFitTools, forEvaluator('job_fit'), signal, jobFitSchema, exec)),
    stageRun('salary', [], () =>
      runSalaryEvaluator(jobMarkdown, profile, config, customPrompt, salaryTools, forEvaluator('salary'), signal, salarySchema, exec)),
  ])

  // Conclusions piped into the downstream stage. Guaranteed defined when the
  // dependent evaluator actually runs (stageRun blocks it otherwise).
  const preferenceResult = ok('preference') ? results.preference!.result as PreferenceResult : undefined
  const jobFitResult = ok('job_fit') ? results.job_fit!.result as JobFitResult : undefined
  const salaryResult = ok('salary') ? results.salary!.result as SalaryResult : undefined

  // Sources the upstream stage already found, deduped — handed downstream so
  // risk/growth inherit the research instead of redoing it.
  const priorResearch = poolEvidence(preferenceResult, jobFitResult, salaryResult)

  // Stage 3 — synthesizers. risk needs job_fit + salary; growth needs job_fit.
  await Promise.all([
    stageRun('risk', ['job_fit', 'salary'], () =>
      runRiskEvaluator(jobMarkdown, profile, config, customPrompt, riskTools, forEvaluator('risk'), signal, riskSchema, { jobFit: jobFitResult, salary: salaryResult }, priorResearch, exec)),
    stageRun('growth', ['job_fit'], () =>
      runGrowthEvaluator(jobMarkdown, profile, config, customPrompt, growthTools, forEvaluator('growth'), signal, growthSchema, jobFitResult, priorResearch, exec)),
  ])

  const evaluators = {
    job_fit: (results.job_fit ?? { status: 'blocked' }) as EvaluatorStatus<JobFitResult>,
    salary: (results.salary ?? { status: 'blocked' }) as EvaluatorStatus<SalaryResult>,
    preference: (results.preference ?? { status: 'blocked' }) as EvaluatorStatus<PreferenceResult>,
    risk: (results.risk ?? { status: 'blocked' }) as EvaluatorStatus<RiskResult>,
    growth: (results.growth ?? { status: 'blocked' }) as EvaluatorStatus<GrowthResult>,
  }

  const score = getScore(evaluators)
  const verdict = getVerdict(score, evaluators)

  // Stage 4 — summary. It synthesizes all 5 results, so it depends on all of
  // them: if any failed/blocked, summary is blocked too and the report returns
  // with whatever cards succeeded (reasoning falls back to buildReasoning).
  if (!(ok('job_fit') && ok('salary') && ok('preference') && ok('risk') && ok('growth'))) {
    onProgress?.('summary', 'blocked')
    return aggregate(job, evaluators)
  }

  // Summary runs tool-free (summaryTools is empty), which also lets it use the
  // strict structured-output path. Cancellation (AbortError) propagates; any
  // other failure is surfaced (fail-fast) so the UI can offer a Continue.
  onProgress?.('summary', 'running')
  try {
    const summary = await runSummaryEvaluator(jobMarkdown, evaluators, score, verdict, config, customPrompt, summaryTools, forEvaluator('summary'), signal, summarySchema, exec)
    onProgress?.('summary', 'completed')
    onEvaluatorResult?.('summary', summary)
    return aggregate(job, evaluators, summary.reasoning, summary.job_summary)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    console.error('[evaluator:summary] failed:', e)
    onProgress?.('summary', 'error')
    return aggregate(job, evaluators)
  }
}
