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

## Agent Loop & Tools

Every evaluator runs through the **agent loop** in `src/lib/agent.ts`. The loop drives the LLM with tool-calling until it produces a final content message (no `tool_calls`); that final content is parsed as JSON like any other evaluator output.

### How the agent loop works

1. Send messages → `chatCompletionWithTools` (adds `tools` to the request body)
2. If the response has `tool_calls`:
   - Append the assistant message
   - For each call: invoke `executeTool(call, signal)`, append a `tool` role message with the result
3. Else: return the content
4. Cap at `MAX_AGENT_ITERATIONS = 8` iterations

For the Chrome AI backend (Gemini Nano), tools aren't supported natively — the request goes through without `tools`, the response has no `tool_calls`, and the loop terminates after one iteration. Behavior matches the pre-agent path.

### Tool call protocol

- Request: `tools: [{ type: 'function', function: { name, description, parameters } }]`
- Response: `choices[0].message.tool_calls: [{ id, type, function: { name, arguments } }]`
- Tool result: `{ role: 'tool', tool_call_id, content }`

### Available tools

Defined in `src/lib/tools/definitions.ts`:

| Tool | Args | Behavior |
|---|---|---|
| `google_search` | `query: string` | `fetch` Google, strip `<script>`/`<style>`, trim to first `<h1>Search Results</h1>`, convert remainder to markdown |
| `read_page` | `url: string` | `fetch` any HTTP(S) URL, strip `<script>`/`<style>`, convert to markdown |

### Tool execution pipeline

```
agent loop (service worker or sidepanel)
  └─ executeTool(call, signal)
       └─ googleSearch / readPage  (lib/tools/handlers.ts)
            ├─ fetch(url)             ← service worker does the fetch
            └─ chrome.runtime.sendMessage({ type: 'PARSE_HTML', html, trimToAnchor? })
                 │
                 ▼
            offscreen document  (src/entrypoints/offscreen/)
                 └─ DOMParser + Turndown  ← the "invisible place"
```

The **offscreen document** (`src/entrypoints/offscreen.html`) is created eagerly by the service worker on install via `chrome.offscreen.createDocument` (reason: `DOM_PARSER`). It runs DOMParser + Turndown so the service worker stays free of heavy HTML work and is shielded from MV3 worker lifecycle issues.

The service worker's `onMessage` listener returns `false` for `PARSE_HTML` messages, letting the offscreen's listener claim the `sendResponse`. This avoids the "first-listener-wins" trap of `chrome.runtime.sendMessage` broadcasting to all extension pages.

### `runAgentWithValidation`

`runAgentWithValidation<T>()` (`src/lib/agent.ts`) is the agent-aware replacement for `runWithValidation`. It runs the agent loop, parses the final content as JSON, validates, and retries once on parse/validation failure — same semantics as `runWithValidation`, but tools are available.

All 5 evaluators + the summary evaluator use it. The Risk evaluator's prompt explicitly mentions the available tools, since looking up unknown companies is its primary use case. Other evaluators can opt in by adding a similar note.
