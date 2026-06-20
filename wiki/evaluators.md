# Evaluators

All evaluators live in `src/evaluators/`. They run in parallel via `runner.ts` and are combined by `aggregator.ts`.

## Runner (`runner.ts`)

`runAllEvaluators(job, profile, config, customPrompt, onProgress, onToolCall?, signal?, onEvaluatorResult?, priorResults?)` orchestrates execution:

- **Staged, dependency-aware, fail-fast.** Order: `preference` (first, to warm the
  LLM KV cache) → `[job_fit, salary]` (parallel) → `[risk, growth]` (parallel) →
  `summary`. Hard deps: `risk`←`job_fit`+`salary`; `growth`←`job_fit`;
  `summary`←all 5.
- An evaluator runs only once its deps have **fulfilled**. If a dep failed (or was
  itself blocked), the evaluator is marked **`blocked`** (a distinct
  `EvaluatorStatus.status`) and never runs — the pipeline stops along that branch
  instead of degrading to a JD-only fallback. Parallel siblings still settle in
  full (`stageRun` never throws), so an in-flight sibling isn't aborted when its
  partner fails.
- `runWithTracking<T>()` captures a thrown evaluator as `{status:'rejected'}`;
  `stageRun` then propagates `blocked` to dependents via the `ok()` check.
- **Resume:** `priorResults` (a `Partial<AggregatedReport['evaluators']>` of
  previously-fulfilled results) is reused instead of re-run, so the UI's
  "Continue" re-runs only the failed evaluators + their dependents. See
  `useTabSessions.continueAnalysis` and `AnalysisReport`'s Continue banner.
- Calls `onProgress(name, status)` after each evaluator settles (status is
  `running | completed | error | blocked`)
- Calls `onToolCall(evaluatorName, ToolCall)` whenever an evaluator's agent loop
  is about to dispatch a tool — the background service worker re-broadcasts
  these as `ANALYSIS_PROGRESS` messages with `kind: 'tool'` so the sidepanel
  can show live per-evaluator activity ("Searching: …", "Reading: …")
- Each evaluator's `onToolCall` is the same callback tagged with its own name
  (a thin `forEvaluator(name)` wrapper) — the agent loop fires the callback
  before the tool actually runs, so the UI can show "in flight" state.

## Aggregator (`aggregator.ts`)

`aggregate(job, evaluators)` combines results into `AggregatedReport`. It also
walks every evaluator's `evidences` array and produces a deduplicated
`report.references` list — one entry per unique URL, with `cited_by` listing
the evaluators that referenced it. URLs are normalized (lowercased, query and
fragment stripped) before dedup.

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

All 5 research-style evaluators share an `evidences: EvidenceItem[]` field on
their output:

```ts
interface EvidenceItem {
  title: string
  url: string
  snippet?: string
}
```

The model's prompt instructs it to populate `evidences` with the pages it
actually read (or search results it clicked through and read), one per source.
The aggregator deduplicates by normalized URL across evaluators and tags each
entry with the evaluators that cited it — surfacing in the report as a
"References" list with clickable links.

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
  evidences: EvidenceItem[]
}
```

---

### Salary (`salary.ts`)

**Role:** Compensation analyst with currency/COL adjustment awareness.

**Inputs:** Job description, `salary_expectation`, `years_of_experience`

**Output:**
```ts
{
  estimated_range: { min: number; max: number; currency: string }
  expectation_alignment: "above" | "within" | "below"
  // "above" = job pays MORE than expected (good for candidate)
  // "below" = job pays LESS than expected (bad)
  risk_flag: boolean
  reasoning: string
  evidences: EvidenceItem[]
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
  evidences: EvidenceItem[]
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
  evidences: EvidenceItem[]
}
```

The Risk evaluator's prompt explicitly names the tools (web_search,
read_page) and instructs it to use them when the JD lacks information — the
primary user case is "look up an unknown company" (stealth mode, founding
team, etc.). `evidences` lets the user verify what the analyst actually read.

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
  evidences: EvidenceItem[]
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

The model returns the resume as raw Markdown followed by a `---SUMMARY---` delimiter and the changelog (not JSON — avoids escaping a long Markdown doc inside a JSON string); `splitResumeOutput` splits on the delimiter, and a single retry fires if the delimiter or resume is missing.

Supports iterative refinement: each regeneration receives the previous version and cumulative changelog, so improvements accumulate without losing history.

---

## LLM Validation

`src/lib/llm-client.ts` provides:

- `runWithValidation<T>()` — one-shot retry if JSON validation fails (reprompts with error context)
- `validateNumbers(obj, fields)` — asserts numeric fields are in 0–1 range
- HTTP retry on 429/5xx with backoff delays: 1 s → 3 s
- 30-second request timeout

## Agent Loop & Tools

Every evaluator runs through the **agent loop** in `src/lib/agent.ts`. The loop drives the LLM with tool-calling until it produces a final answer; that answer is parsed as JSON like any other evaluator output.

### Output strategy (3 paths)

The runner resolves an output strategy per evaluator via `resolveOutput()`:

| Path | When | How |
|---|---|---|
| **Strict json_schema** | `structured_output === true` AND evaluator has no research tools | `response_format.json_schema` enforces shape server-side. No verdict tool, no parse/retry. |
| **Verdict tool** (`provide_verdict`) | Otherwise (broad: any evaluator when structured_output off, or tool-using evaluators always) | The model calls `provide_verdict` with the verdict object as its arguments. The agent loop treats this as terminal. |
| **Chrome / Qwen backend** | `chrome-prompt` / `qwen-chat` | No tools, no json_schema. Inline-prompt + parseJSON. |

The verdict tool is the fallback for evaluators that can't use strict json_schema — namely any evaluator when `structured_output` is off, and tool-using evaluators (risk, salary, growth, preference) even when `structured_output` is on (strict json_schema blocks `tool_calls`).

### How the agent loop works

1. Send messages → `chatCompletionWithTools` (adds `tools` to the request body)
2. If the response calls the **verdict tool** (terminal): return its args as the final content.
3. Else if the response has `tool_calls`:
   - Append the assistant message
   - For each call: invoke `executeTool(call, signal)`, append a `tool` role message with the result
4. Else (no tool_calls):
   - If a verdict tool is expected: nudge ("call `provide_verdict`") and loop
   - Otherwise: return the content
5. Cap at MAX_AGENT_ITERATIONS = 10

### Turn limits

- **MAX_TOOL_ROUNDS = 5**: after 5 rounds, research tools (`web_search`, `read_page`) are stripped. The verdict tool **survives** past this limit. When only the verdict tool remains, the nudge loop ("call `provide_verdict`") guides the model to submit its answer.
- **MAX_AGENT_ITERATIONS = 10**: hard ceiling on the entire loop. Bounded even with the verdict-nudge retry path.

For evaluators with no research tools (job_fit, summary when structured_output is off), only the verdict tool is shown from iteration 0.

For the Chrome AI backend (Gemini Nano), tools aren't supported natively — the request goes through without `tools`, the response has no `tool_calls`, and the loop terminates after one iteration. Behavior matches the pre-agent path.

### Tool call protocol

- Request: `tools: [{ type: 'function', function: { name, description, parameters } }]`
- Response: `choices[0].message.tool_calls: [{ id, type, function: { name, arguments } }]`
- Tool result: `{ role: 'tool', tool_call_id, content }`

### Available tools

Defined in `src/lib/tools/definitions.ts`:

| Tool | Args | Behavior |
|---|---|---|
| `web_search` | `query: string` | `fetch` DuckDuckGo HTML endpoint, strip `<script>`/`<style>`, convert to markdown |
| `read_page` | `url: string` | `fetch` any HTTP(S) URL, strip `<script>`/`<style>`, convert to markdown |
| `provide_verdict` | `<evaluator schema>` | **Terminal.** Submit the final structured verdict. The parameters ARE the evaluator's JSON schema — calling it yields a JSON object of exactly the right shape. Survives past MAX_TOOL_ROUNDS; the agent loop ends when this tool is called. |

### Tool execution pipeline

```text
agent loop (service worker or sidepanel)
  └─ executeTool(call, signal)
       └─ webSearch / readPage  (lib/tools/handlers.ts)
            ├─ fetch(url)             ← service worker does the fetch
            └─ chrome.runtime.sendMessage({ type: 'PARSE_HTML', html })
                 │
                 ▼
            offscreen document  (src/entrypoints/offscreen/)
                 └─ DOMParser + Turndown  ← the "invisible place"
```

The **offscreen document** (`src/entrypoints/offscreen.html`) is created eagerly by the service worker on install via `chrome.offscreen.createDocument` (reason: `DOM_PARSER`). It runs DOMParser + Turndown so the service worker stays free of heavy HTML work and is shielded from MV3 worker lifecycle issues.

The service worker's `onMessage` listener returns `false` for `PARSE_HTML` messages, letting the offscreen's listener claim the `sendResponse`. This avoids the "first-listener-wins" trap of `chrome.runtime.sendMessage` broadcasting to all extension pages.

### `runAgentWithValidation`

`runAgentWithValidation<T>()` (`src/lib/agent.ts`) is the agent-aware replacement for `runWithValidation`. It runs the agent loop, parses the final content as JSON, validates, and retries once on parse/validation failure — same semantics as `runWithValidation`, but tools are available.

When a `verdictToolName` is provided, a system instruction is injected ("call `provide_verdict` to end your turn") and the retry message directs the model back through the verdict tool instead of asking for plain JSON.

All 5 evaluators + the summary evaluator use it. The Risk evaluator's prompt explicitly mentions the available tools, since looking up unknown companies is its primary use case. Other evaluators can opt in by adding a similar note.

### Live activity feed

The agent loop exposes an `onToolCall(call)` hook on `AgentOptions`. Each
evaluator forwards this to the runner, which tags every call with the
evaluator's name and re-emits a 2-arg `(name, call)` callback. The background
service worker turns those into `ANALYSIS_PROGRESS` messages with
`kind: 'tool'` (alongside the existing `kind: 'status'` transitions), so the
sidepanel can show a per-evaluator "Searching: …" / "Reading: …" badge that
streams in real time.

The wire format keeps a per-evaluator monotonic `seq` so the UI can dedupe /
supersede in-flight activity (the latest "Searching X" replaces the previous
one for that evaluator's display row). On `completed` / `error`, the
sidepanel clears the activity for that evaluator.
