import type { ExtractedJob } from './job'

// A source the LLM actually read or cited while forming an answer. Populated
// from the tool pipeline (web_search / read_page results), so the final
// report can show the user where each evaluator's conclusions came from.
export interface EvidenceItem {
  title: string
  url: string
  snippet?: string
  // Which evaluator(s) cited this source. Filled in by the aggregator when
  // collecting across evaluators; not present on per-evaluator outputs.
  cited_by?: string[]
}

// --- Individual evaluator results ---

export interface JobFitResult {
  skill_match: number
  experience_match: number
  overall_fit: number
  matching_skills: string[]
  gaps: string[]
  strengths: string[]
  summary: string
  evidences: EvidenceItem[]
}

export interface SalaryResult {
  estimated_range: { min: number; max: number; currency: string }
  expectation_alignment: 'below' | 'within' | 'above'
  risk_flag: boolean
  reasoning: string
  evidences: EvidenceItem[]
}

export interface PreferenceResult {
  alignment_score: number
  conflicts: PreferenceConflict[]
  matches: string[]
  summary: string
  evidences: EvidenceItem[]
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
  evidences: EvidenceItem[]
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
  evidences: EvidenceItem[]
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
  job_summary?: string
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
  // Unique sources used across all evaluators, with the citing evaluators
  // attached. Aggregated from `evidences` in each evaluator result.
  references: EvidenceItem[]
}
