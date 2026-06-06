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
type ProgressCallback = (evaluator: string, status: 'running' | 'completed' | 'error') => void
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
      if (!ev?.url) continue
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
    const err = e as Error
    // AbortError is expected — the user stopped the analysis or the tab closed.
    // It's a cancellation, not a failure, so don't surface it as an error.
    if (err.name !== 'AbortError') {
      console.error(`[evaluator:${name}] failed:`, e)
    }
    onProgress?.(name, 'error')
    return { status: 'rejected', error: err.message }
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
  onEvaluatorResult?: EvaluatorResultCallback
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

  // This call goes out first to generate KV cache for the LLM
  const preference = await runWithTracking<PreferenceResult>('preference', () =>
    runPreferenceEvaluator(jobMarkdown, profile, config, customPrompt, preferenceTools, forEvaluator('preference'), signal, preferenceSchema, exec)
    , onProgress, onEvaluatorResult)

  const [jobFit, salary] = await Promise.all([
    runWithTracking<JobFitResult>('job_fit', () =>
      runJobFitEvaluator(jobMarkdown, profile, config, customPrompt, jobFitTools, forEvaluator('job_fit'), signal, jobFitSchema, exec)
      , onProgress, onEvaluatorResult),
    runWithTracking<SalaryResult>('salary', () =>
      runSalaryEvaluator(jobMarkdown, profile, config, customPrompt, salaryTools, forEvaluator('salary'), signal, salarySchema, exec)
      , onProgress, onEvaluatorResult),
  ])

  // Pipe the upstream conclusions into the downstream stage. Either may be
  // undefined if its evaluator failed — risk/growth fall back to deriving from
  // the JD alone (preserves the error isolation runWithTracking provides).
  const jobFitResult = jobFit.status === 'fulfilled' ? jobFit.result : undefined
  const salaryResult = salary.status === 'fulfilled' ? salary.result : undefined
  const preferenceResult = preference.status === 'fulfilled' ? preference.result : undefined

  // Sources the upstream stage already found, deduped — handed to the
  // downstream stage so risk/growth inherit the research instead of redoing it.
  const priorResearch = poolEvidence(preferenceResult, jobFitResult, salaryResult)

  const [risk, growth] = await Promise.all([
    runWithTracking<RiskResult>('risk', () =>
      runRiskEvaluator(jobMarkdown, profile, config, customPrompt, riskTools, forEvaluator('risk'), signal, riskSchema, { jobFit: jobFitResult, salary: salaryResult }, priorResearch, exec)
      , onProgress, onEvaluatorResult),
    runWithTracking<GrowthResult>('growth', () =>
      runGrowthEvaluator(jobMarkdown, profile, config, customPrompt, growthTools, forEvaluator('growth'), signal, growthSchema, jobFitResult, priorResearch, exec)
      , onProgress, onEvaluatorResult),
  ])

  const evaluators = { job_fit: jobFit, salary, preference, risk, growth }

  // Summary runs after — it depends on all evaluator results. It synthesizes
  // what the evaluators already gathered, so it runs tool-free (summaryTools is
  // empty), which also lets it use the strict structured-output path.
  const score = getScore(evaluators)
  const verdict = getVerdict(score, evaluators)

  // The summary must not be a single point of failure: the 5 evaluators above
  // may have already succeeded, so a summary error should still yield a report
  // with their cards intact. Cancellation (AbortError) still propagates.
  onProgress?.('summary', 'running')
  let summary: { job_summary: string; reasoning: string }
  try {
    summary = await runSummaryEvaluator(jobMarkdown, evaluators, score, verdict, config, customPrompt, summaryTools, forEvaluator('summary'), signal, summarySchema, exec)
    onProgress?.('summary', 'completed')
    onEvaluatorResult?.('summary', summary)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    console.error('[evaluator:summary] failed:', e)
    onProgress?.('summary', 'error')
    summary = { job_summary: '', reasoning: 'Summary generation failed.' }
  }

  return aggregate(job, evaluators, summary.reasoning, summary.job_summary)
}
