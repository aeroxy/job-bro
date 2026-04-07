# Evaluators

All evaluators live in `src/evaluators/`. They run in parallel via `runner.ts` and are combined by `aggregator.ts`.

## Runner (`runner.ts`)

`runAllEvaluators(job, profile, config, customPrompt, onProgress)` orchestrates execution:

- Wraps each evaluator in `runWithTracking<T>()` for error isolation and progress reporting
- Runs all 5 via `Promise.all` — a single failure doesn't block others
- Calls `onProgress(name, status)` after each evaluator settles

## Aggregator (`aggregator.ts`)

`aggregate(job, evaluators)` combines results into `AggregatedReport`.

### Scoring Weights

| Evaluator | Weight |
|---|---|
| Job Fit | 35% |
| Salary | 20% |
| Preference | 15% |
| Risk | 15% |
| Growth | 15% |

Risk is inverted: `low → 0.9`, `medium → 0.5`, `high → 0.2`.
Salary alignment maps: `above → 0.9`, `within → 0.7`, `below → 0.35`.

### Verdict Logic

| Condition | Verdict |
|---|---|
| High risk AND deal-breaker conflict | Skip |
| Salary risk AND below alignment AND score ≥ 70 | Maybe (capped) |
| score ≥ 70 | Strong Apply |
| score ≥ 45 | Maybe |
| score < 45 | Skip |

---

## Individual Evaluators

### Job Fit (`job-fit.ts`)

**Role:** Technical recruiter assessing skill and experience alignment.

**Inputs:** Job description (Markdown), resume, projects

**Output:**
```ts
{
  skill_match: number       // 0–1
  experience_match: number  // 0–1
  overall_fit: number       // 0–1
  matching_skills: string[]
  gaps: string[]
  strengths: string[]
  summary: string
}
```

---

### Salary (`salary.ts`)

**Role:** Compensation analyst with currency/COL adjustment awareness.

**Inputs:** Job description, `salary_expectation`, `years_of_experience`

**Output:**
```ts
{
  estimated_range: { min: number, max: number, currency: string }
  expectation_alignment: "above" | "within" | "below"
  // "above" = job pays MORE than expected (good for candidate)
  // "below" = job pays LESS than expected (bad)
  risk_flag: boolean
  reasoning: string
}
```

---

### Preference (`preference.ts`)

**Role:** Career advisor matching job to user lifestyle preferences.

**Inputs:** Job description, `JobPreferences` (remote, locations, company size, industries, deal breakers)

**Output:**
```ts
{
  alignment_score: number   // 0–1
  conflicts: Array<{
    category: string
    expected: string
    actual: string
    severity: "low" | "medium" | "high"
  }>
  matches: string[]
  summary: string
}
```

---

### Risk (`risk.ts`)

**Role:** Job posting red flag detector.

**Detects:** under-leveling, overqualification, vague JD, toxic culture signals, unrealistic requirements, high turnover indicators

**Output:**
```ts
{
  overall_risk: "low" | "medium" | "high"
  flags: Array<{
    type: string
    description: string
    severity: "low" | "medium" | "high"
  }>
  summary: string
}
```

---

### Growth (`growth.ts`)

**Role:** Career strategist evaluating long-term value of the role.

**Output:**
```ts
{
  learning: number           // 0–1
  brand_value: number        // 0–1
  career_trajectory: number  // 0–1
  overall_growth: number     // 0–1
  highlights: string[]
  concerns: string[]
  summary: string
}
```

---

### Resume Generator (`resume.ts`)

Not part of the analysis pipeline — triggered separately.

**Role:** Expert resume writer tailoring the user's resume to a specific job.

**Inputs:** Job description, original resume, projects, analysis context, previous iteration state, user feedback

**Output:**
```ts
{
  resume: string    // Markdown-formatted resume
  summary: string   // Cumulative changelog across all iterations
}
```

Supports iterative refinement: each regeneration receives the previous version and cumulative changelog, so improvements accumulate without losing history.

---

## LLM Validation

`src/lib/llm-client.ts` provides:

- `runWithValidation<T>()` — one-shot retry if JSON validation fails (reprompts with error context)
- `validateNumbers(obj, fields)` — asserts numeric fields are in 0–1 range
- HTTP retry on 429/5xx with backoff delays: 1 s → 3 s
- 30-second request timeout
