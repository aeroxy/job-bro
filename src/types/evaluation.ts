import type { ExtractedJob } from './job'

// --- Individual evaluator results ---

export interface JobFitResult {
  skill_match: number
  experience_match: number
  overall_fit: number
  matching_skills: string[]
  gaps: string[]
  strengths: string[]
  summary: string
}

export interface SalaryResult {
  estimated_range: { min: number; max: number; currency: string }
  expectation_alignment: 'below' | 'within' | 'above'
  risk_flag: boolean
  reasoning: string
}

export interface PreferenceResult {
  alignment_score: number
  conflicts: PreferenceConflict[]
  matches: string[]
  summary: string
}

export interface PreferenceConflict {
  category: string
  expected: string
  actual: string
  severity: 'low' | 'medium' | 'high'
}

export interface RiskResult {
  overall_risk: 'low' | 'medium' | 'high'
  flags: RiskFlag[]
  summary: string
}

export interface RiskFlag {
  type:
    | 'under_leveling'
    | 'overqualification'
    | 'vague_jd'
    | 'toxic_signal'
    | 'unrealistic_requirements'
    | 'high_turnover_signal'
    | 'other'
  description: string
  severity: 'low' | 'medium' | 'high'
}

export interface GrowthResult {
  learning_opportunity: number
  brand_value: number
  career_trajectory: number
  overall_growth: number
  highlights: string[]
  concerns: string[]
  summary: string
}

// --- Aggregated result ---

export type Verdict = 'Strong Apply' | 'Maybe' | 'Skip'

export interface EvaluatorStatus<T> {
  status: 'fulfilled' | 'rejected'
  result?: T
  error?: string
}

export interface AggregatedReport {
  job: ExtractedJob
  evaluated_at: number
  verdict: Verdict
  overall_score: number
  reasoning: string
  key_risks: string[]
  negotiation_tips: string[]
  evaluators: {
    job_fit: EvaluatorStatus<JobFitResult>
    salary: EvaluatorStatus<SalaryResult>
    preference: EvaluatorStatus<PreferenceResult>
    risk: EvaluatorStatus<RiskResult>
    growth: EvaluatorStatus<GrowthResult>
  }
}
