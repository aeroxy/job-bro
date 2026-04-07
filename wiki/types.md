# Types Reference

All types live in `src/types/`.

---

## `ExtractedJob` (`job.ts`)

Parsed output of the LinkedIn content script.

```ts
interface ExtractedJob {
  url: string
  title: string
  company: string
  location: string
  salary_range?: string
  employment_type?: string          // "Full-time" | "Part-time" | "Contract" | ...
  experience_level?: string         // "Entry level" | "Mid-Senior level" | ...
  description: string
  requirements: string[]
  benefits: string[]
}
```

---

## `UserProfile` (`profile.ts`)

Stored in `chrome.storage.local` under key `profile`.

```ts
interface UserProfile {
  resume: string
  salary_expectation: string
  projects: string
  preferences: JobPreferences
}

interface JobPreferences {
  remote_preference: "remote" | "hybrid" | "onsite" | "flexible"
  preferred_locations: string[]
  company_size_preference: string
  industries_of_interest: string[]
  deal_breakers: string[]
  years_of_experience: number
}
```

---

## `LLMConfig` (`profile.ts`)

Stored in `chrome.storage.local` under key `llmConfig`.

```ts
interface LLMConfig {
  base_url: string
  model: string
  api_key?: string
  custom_headers?: string   // JSON string, parsed before use
}
```

---

## Evaluator Result Types (`evaluation.ts`)

```ts
interface JobFitResult {
  skill_match: number
  experience_match: number
  overall_fit: number
  matching_skills: string[]
  gaps: string[]
  strengths: string[]
  summary: string
}

interface SalaryResult {
  estimated_range: { min: number; max: number; currency: string }
  expectation_alignment: "above" | "within" | "below"
  risk_flag: boolean
  reasoning: string
}

interface PreferenceResult {
  alignment_score: number
  conflicts: Array<{ category: string; expected: string; actual: string; severity: "low" | "medium" | "high" }>
  matches: string[]
  summary: string
}

interface RiskResult {
  overall_risk: "low" | "medium" | "high"
  flags: Array<{ type: string; description: string; severity: "low" | "medium" | "high" }>
  summary: string
}

interface GrowthResult {
  learning: number
  brand_value: number
  career_trajectory: number
  overall_growth: number
  highlights: string[]
  concerns: string[]
  summary: string
}
```

---

## `AggregatedReport` (`evaluation.ts`)

Final output of the analysis pipeline.

```ts
interface AggregatedReport {
  verdict: Verdict                     // "Strong Apply" | "Maybe" | "Skip"
  overall_score: number                // 0–100
  reasoning: string
  risks: Array<{ description: string; severity: "high" | "medium" }>
  negotiation_tips: string[]
  job_fit: EvaluatorStatus<JobFitResult>
  salary: EvaluatorStatus<SalaryResult>
  preference: EvaluatorStatus<PreferenceResult>
  risk: EvaluatorStatus<RiskResult>
  growth: EvaluatorStatus<GrowthResult>
}

type Verdict = "Strong Apply" | "Maybe" | "Skip"

type EvaluatorStatus<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: string }
```

---

## `AnalysisRecord` (`db.ts`)

Persisted to IndexedDB.

```ts
interface AnalysisRecord {
  id: string         // auto-generated
  job: ExtractedJob
  report: AggregatedReport
  createdAt: number  // Unix timestamp
}
```

---

## Message Types (`messages.ts`)

IPC payloads for `chrome.runtime.sendMessage`. See [architecture.md](architecture.md) for full message flow table.
