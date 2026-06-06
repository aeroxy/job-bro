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

import { runGrowthEvaluator, GROWTH_JSON_SCHEMA } from './growth'
import { runJobFitEvaluator, JOB_FIT_JSON_SCHEMA } from './job-fit'
import { runPreferenceEvaluator, PREFERENCE_JSON_SCHEMA } from './preference'
import { runRiskEvaluator, RISK_JSON_SCHEMA } from './risk'
import { runSalaryEvaluator, SALARY_JSON_SCHEMA } from './salary'
import { runSummaryEvaluator, SUMMARY_JSON_SCHEMA } from './summary'
import { aggregate, getScore, getVerdict } from './aggregator'
import { jobToMarkdown } from '@/extractor/markdown'
import { ALL_TOOLS } from '@/lib/tools/definitions'
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
    console.error(`[evaluator:${name}] failed:`, e)
    onProgress?.(name, 'error')
    return { status: 'rejected', error: (e as Error).message }
  }
}

// Resolved once per run from the active config. Cloud-only: when the user
// has disabled tools for this profile (local LLM servers that don't
// support function-calling), pass an empty tools array so the agent
// loop's first response has no `tool_calls` and the loop exits after 1
// iteration. Chrome backend never receives tools regardless, so this flag
// has no effect there.
function resolveTools(config: LLMConfig): ToolDefinition[] {
  return config.tools_enabled === false ? [] : ALL_TOOLS
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
  const tools = resolveTools(config)
  // All evaluators share the same tools array for this run, so resolveSchema
  // drops the schema uniformly when tools are enabled. If a future per-
  // evaluator tool flag is added, this is the place to fan out the decision.
  const jobFitSchema = resolveSchema(config, JOB_FIT_JSON_SCHEMA, tools)
  const salarySchema = resolveSchema(config, SALARY_JSON_SCHEMA, tools)
  const preferenceSchema = resolveSchema(config, PREFERENCE_JSON_SCHEMA, tools)
  const riskSchema = resolveSchema(config, RISK_JSON_SCHEMA, tools)
  const growthSchema = resolveSchema(config, GROWTH_JSON_SCHEMA, tools)
  const summarySchema = resolveSchema(config, SUMMARY_JSON_SCHEMA, tools)

  // Wrap the orchestrator-level onToolCall with the evaluator name so the UI
  // can route each event to the right card.
  const forEvaluator = (name: string) => (call: ToolCall) => onToolCall?.(name, call)

  const jobFit = await runWithTracking<JobFitResult>('job_fit', () =>
    runJobFitEvaluator(jobMarkdown, profile, config, customPrompt, tools, forEvaluator('job_fit'), signal, jobFitSchema)
    , onProgress, onEvaluatorResult)

  // All the rest evaluators run in parallel — each builds its own focused context
  const [salary, preference, risk, growth] = await Promise.all([
    runWithTracking<SalaryResult>('salary', () =>
      runSalaryEvaluator(jobMarkdown, profile, config, customPrompt, tools, forEvaluator('salary'), signal, salarySchema)
      , onProgress, onEvaluatorResult),
    runWithTracking<PreferenceResult>('preference', () =>
      runPreferenceEvaluator(jobMarkdown, profile, config, customPrompt, tools, forEvaluator('preference'), signal, preferenceSchema)
      , onProgress, onEvaluatorResult),
    runWithTracking<RiskResult>('risk', () =>
      runRiskEvaluator(jobMarkdown, profile, config, customPrompt, tools, forEvaluator('risk'), signal, riskSchema)
      , onProgress, onEvaluatorResult),
    runWithTracking<GrowthResult>('growth', () =>
      runGrowthEvaluator(jobMarkdown, profile, config, customPrompt, tools, forEvaluator('growth'), signal, growthSchema)
      , onProgress, onEvaluatorResult),
  ])

  const evaluators = { job_fit: jobFit, salary, preference, risk, growth }

  console.log('evaluators result', evaluators)

  // Summary runs after — it depends on all evaluator results. It can also
  // benefit from tools (e.g. looking up the company's industry), so it
  // respects the same flag.
  const score = getScore(evaluators)
  const verdict = getVerdict(score, evaluators)

  onProgress?.('summary', 'running')
  const summary = await runSummaryEvaluator(jobMarkdown, evaluators, score, verdict, config, customPrompt, tools, signal, summarySchema)
  onProgress?.('summary', 'completed')
  onEvaluatorResult?.('summary', summary)

  return aggregate(job, evaluators, summary.reasoning, summary.job_summary)
}
