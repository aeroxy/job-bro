# Components & Hooks

## React Hooks (`src/hooks/`)

### `useAnalysis`

Drives the extract → analyze workflow.

**State:** `status` (`idle` | `extracting` | `analyzing` | `done` | `error`), `job`, `report`, `error`, `progress`

**Methods:**
- `extract()` — sends `REQUEST_EXTRACTION` to background, listens for `JD_EXTRACTED`
- `analyze(job)` — sends `ANALYZE_JD`, tracks `ANALYSIS_PROGRESS` messages for live updates
- `reset()` — clears all state

---

### `useProfile`

Loads and persists user profile and LLM config.

**State:** `profile`, `llmConfig`, `customPrompt`, `loading`

**Computed:** `isProfileComplete`, `isLLMConfigured`

**Methods:** `updateProfile()`, `updateLLMConfig()`, `updateCustomPrompt()`

Reads from `chrome.storage.local` on mount, persists on every update.

---

### `useResumeGenerator`

Manages iterative resume generation.

**State:** `status`, `markdown`, `summary`, `error`

**Methods:**
- `generate(job, analysisContext)` — first generation pass
- `regenerate(job, comment)` — refinement with user feedback; preserves previous markdown and cumulative changelog
- `reset()`, `setMarkdown(md)` — manual control

---

### `useHistory`

IndexedDB-backed analysis history.

**State:** `records[]`, `loading`

**Methods:** `refresh()`, `remove(id)`, `clearAll()`, `get(id)`

---

## UI Components (`src/components/`)

### `AnalysisReport`

Top-level report renderer. Takes `AggregatedReport` and displays:
- `VerdictBadge` (verdict + score)
- `EvaluatorCard` for each of the 5 evaluators (collapsible)
- Key risks list
- Negotiation tips list

Each evaluator card expands into a detail sub-component: `JobFitDetail`, `SalaryDetail`, `PreferenceDetail`, `RiskDetail`, `GrowthDetail`.

---

### `EvaluatorCard`

Radix UI `Collapsible` wrapper showing:
- Title + icon
- Status indicator: `pending` | `running` | `completed` | `error`
- Content hidden until evaluator completes

---

### `JobSummaryCard`

Displays `ExtractedJob` metadata: title, company, location, salary range, employment type, experience level — with Lucide icons.

---

### `ProfileForm`

Form for editing `UserProfile`:
- Textarea: resume, projects
- Text: salary_expectation
- Select: remote_preference
- Tag-style inputs: preferred_locations, industries_of_interest, deal_breakers
- Number: years_of_experience

---

### `SettingsForm`

Form for editing `LLMConfig` + custom system prompt:
- Text: base_url, model
- Password (show/hide toggle): api_key
- JSON textarea: custom_headers
- Large textarea: custom system prompt (prepended to all evaluators)

---

### `ResumeView`

Two-tab interface (Preview | Edit):
- **Preview** — renders Markdown to HTML via `marked`
- **Edit** — raw Markdown textarea

Feedback form (Cmd+Enter to submit) triggers `regenerate()`.

Download buttons:
- `.md` — triggers blob download via `downloadMarkdown()`
- `.pdf` — opens print dialog via `downloadPDF()`

---

### `HistoryList`

Scrollable list of past `AnalysisRecord` entries:
- Shows title, company, relative timestamp (`timeAgo()`), `VerdictBadge`
- Trash icon per item, "Clear All" button

---

### `VerdictBadge`

Color-coded badge:
- **Strong Apply** → green
- **Maybe** → yellow
- **Skip** → red

Displays verdict text + `score/100`.

---

### `ScoreBar`

Horizontal bar with label and percentage. Color thresholds:
- ≥ 70% → green
- 40–69% → yellow
- < 40% → red

---

## Shadcn UI Components (`src/components/ui/`)

Base primitives from Shadcn: `button`, `card`, `input`, `label`, `separator`, `spinner`, `switch`, `textarea`.
