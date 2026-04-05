import type {
  AggregatedReport,
  EvaluatorStatus,
  GrowthResult,
  JobFitResult,
  PreferenceResult,
  RiskResult,
  SalaryResult,
  Verdict,
} from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'

interface EvaluatorResults {
  job_fit: EvaluatorStatus<JobFitResult>
  salary: EvaluatorStatus<SalaryResult>
  preference: EvaluatorStatus<PreferenceResult>
  risk: EvaluatorStatus<RiskResult>
  growth: EvaluatorStatus<GrowthResult>
}

// Coerce any value to a finite number, defaulting to 0 if NaN/null/undefined
function num(v: unknown): number {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

// Weights for each evaluator (must sum to 1.0)
const WEIGHTS = {
  job_fit: 0.35,
  salary: 0.20,
  preference: 0.15,
  risk: 0.15,
  growth: 0.15,
}

function getScore(evaluators: EvaluatorResults): number {
  let totalWeight = 0
  let weightedSum = 0

  // Job Fit
  if (evaluators.job_fit.status === 'fulfilled' && evaluators.job_fit.result) {
    weightedSum += num(evaluators.job_fit.result.overall_fit) * WEIGHTS.job_fit
    totalWeight += WEIGHTS.job_fit
  }

  // Salary (convert alignment to score)
  if (evaluators.salary.status === 'fulfilled' && evaluators.salary.result) {
    const salaryScore =
      evaluators.salary.result.expectation_alignment === 'within'
        ? 0.9
        : evaluators.salary.result.expectation_alignment === 'above'
          ? 0.6
          : 0.4
    const riskPenalty = evaluators.salary.result.risk_flag ? 0.2 : 0
    weightedSum += Math.max(0, salaryScore - riskPenalty) * WEIGHTS.salary
    totalWeight += WEIGHTS.salary
  }

  // Preference
  if (evaluators.preference.status === 'fulfilled' && evaluators.preference.result) {
    weightedSum += num(evaluators.preference.result.alignment_score) * WEIGHTS.preference
    totalWeight += WEIGHTS.preference
  }

  // Risk (inverted: low risk = high score)
  if (evaluators.risk.status === 'fulfilled' && evaluators.risk.result) {
    const riskScore =
      evaluators.risk.result.overall_risk === 'low'
        ? 0.9
        : evaluators.risk.result.overall_risk === 'medium'
          ? 0.5
          : 0.2
    weightedSum += riskScore * WEIGHTS.risk
    totalWeight += WEIGHTS.risk
  }

  // Growth
  if (evaluators.growth.status === 'fulfilled' && evaluators.growth.result) {
    weightedSum += num(evaluators.growth.result.overall_growth) * WEIGHTS.growth
    totalWeight += WEIGHTS.growth
  }

  if (totalWeight === 0) return 0
  return Math.round((weightedSum / totalWeight) * 100)
}

function getVerdict(score: number, evaluators: EvaluatorResults): Verdict {
  // Override: high risk + deal-breaker conflicts → Skip
  const hasHighRisk =
    evaluators.risk.status === 'fulfilled' &&
    evaluators.risk.result?.overall_risk === 'high'

  const hasDealBreakerConflict =
    evaluators.preference.status === 'fulfilled' &&
    evaluators.preference.result?.conflicts.some((c) => c.severity === 'high')

  if (hasHighRisk && hasDealBreakerConflict) return 'Skip'

  // Override: salary risk + below alignment → cap at Maybe
  const hasSalaryRisk =
    evaluators.salary.status === 'fulfilled' &&
    evaluators.salary.result?.risk_flag &&
    evaluators.salary.result?.expectation_alignment === 'below'

  if (hasSalaryRisk && score >= 70) return 'Maybe'

  // Standard thresholds
  if (score >= 70) return 'Strong Apply'
  if (score >= 45) return 'Maybe'
  return 'Skip'
}

function buildReasoning(evaluators: EvaluatorResults, verdict: Verdict, score: number): string {
  const parts: string[] = []
  parts.push(`Overall score: ${score}/100 - Verdict: ${verdict}.`)

  if (evaluators.job_fit.status === 'fulfilled' && evaluators.job_fit.result) {
    parts.push(evaluators.job_fit.result.summary)
  }

  if (evaluators.salary.status === 'fulfilled' && evaluators.salary.result) {
    parts.push(evaluators.salary.result.reasoning)
  }

  return parts.join(' ')
}

function collectRisks(evaluators: EvaluatorResults): string[] {
  const risks: string[] = []

  if (evaluators.risk.status === 'fulfilled' && evaluators.risk.result) {
    for (const flag of (evaluators.risk.result.flags ?? [])) {
      if (flag.severity !== 'low') {
        risks.push(`${flag.type.replace(/_/g, ' ')}: ${flag.description}`)
      }
    }
  }

  if (evaluators.preference.status === 'fulfilled' && evaluators.preference.result) {
    for (const conflict of (evaluators.preference.result.conflicts ?? [])) {
      if (conflict.severity === 'high') {
        risks.push(`${conflict.category}: Expected "${conflict.expected}", got "${conflict.actual}"`)
      }
    }
  }

  return risks
}

function collectNegotiationTips(evaluators: EvaluatorResults): string[] {
  const tips: string[] = []

  if (evaluators.salary.status === 'fulfilled' && evaluators.salary.result) {
    const s = evaluators.salary.result
    if (s.expectation_alignment === 'within' || s.expectation_alignment === 'above') {
      tips.push(
        `Market range is $${s.estimated_range.min.toLocaleString()}-$${s.estimated_range.max.toLocaleString()} ${s.estimated_range.currency}. Your expectation is ${s.expectation_alignment} this range.`
      )
    } else {
      tips.push(
        `Market range is $${s.estimated_range.min.toLocaleString()}-$${s.estimated_range.max.toLocaleString()} ${s.estimated_range.currency}. Consider adjusting expectations or negotiating based on your unique value.`
      )
    }
  }

  if (evaluators.job_fit.status === 'fulfilled' && evaluators.job_fit.result) {
    const strengths = evaluators.job_fit.result.strengths ?? []
    if (strengths.length > 0) {
      tips.push(`Leverage your strengths: ${strengths.slice(0, 3).join(', ')}.`)
    }
  }

  return tips
}

export function aggregate(
  job: ExtractedJob,
  evaluators: EvaluatorResults
): AggregatedReport {
  const overall_score = getScore(evaluators)
  const verdict = getVerdict(overall_score, evaluators)
  const reasoning = buildReasoning(evaluators, verdict, overall_score)
  const key_risks = collectRisks(evaluators)
  const negotiation_tips = collectNegotiationTips(evaluators)

  return {
    job,
    evaluated_at: Date.now(),
    verdict,
    overall_score,
    reasoning,
    key_risks,
    negotiation_tips,
    evaluators,
  }
}
