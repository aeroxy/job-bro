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

IndexedDB-backed analysis history sourced from the `sessions` store (sessions with a non-null report), mapped to `AnalysisRecord` shape (`id = job_id`, `createdAt = updatedAt`).

**State:** `records[]`, `loading`

**Methods:** `refresh()`, `remove(id)` (optimistic — no scroll reset), `clearAll()`, `get(id)`

**Standalone exports:**
- `openRecordInLinkedIn(record)` — finds an existing tab by `job_id` and focuses it, or opens a new tab.
- `restoreRecord(record, onRestored?)` — writes a fresh `PersistedSession` (clears Q&A and resume), calls `onRestored(jobId)`, then opens/focuses the tab. No-op if `job_id` is missing.

---

## UI Components (`src/components/`)

### `AnalysisReport`

Top-level report renderer. Takes `AggregatedReport` and displays:
- `VerdictBadge` (verdict + score)
- `EvaluatorCard` for each of the 5 evaluators (collapsible)
- Key risks list
- Negotiation tips list
- `ReportChat` (only when all chat props are provided — omitted in `HistoryDetail`)

Each evaluator card expands into a detail sub-component: `JobFitDetail`, `SalaryDetail`, `PreferenceDetail`, `RiskDetail`, `GrowthDetail`.

All chat props (`qnaHistory`, `chatLoading`, `currentTabId`, `onAppendChat`, `onSetChatLoading`, `onBumpChatNonce`, `onDeleteChatTurn`) are optional — when absent, `ReportChat` is not rendered.

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

Scrollable list of past analyses (sourced from `sessions` store, filtered to those with a report):
- Shows title, company, compact relative timestamp (`14d`, `3h`, `just now`), `VerdictBadge`
- Trash icon per row (hover-revealed) with `confirm()` before delete; delete is optimistic (no scroll reset)
- "Clear All" button in header with `confirm()` guard
- Props: `onSelect(id)`, `onBack()`, `onRestore?(jobId)`

### `HistoryDetail`

Read-only view of a past analysis, loaded by `job_id`:
- Header: Back button + ExternalLink (open in LinkedIn) + RotateCcw (restore session) buttons
- Body: `JobSummaryCard` + `AnalysisReport` (no chat panel)
- Props: `analysisId`, `onBack()`, `onRestore?(jobId)`

---

### `VerdictBadge`

Color-coded badge:
- **Strong Apply** → green
- **Maybe** → yellow
- **Skip** → red

Displays verdict text + `score/100`.

---

### `ReportChat`

Follow-up Q&A panel rendered inside `AnalysisReport` (live sessions only, not history).

**Key behaviors:**
- **Retry button** — shown when the last turn is a dangling user question (no assistant response). Fires immediately with local `retrying` state for instant feedback.
- **Nonce system** — `chatNonce` lives in `TabSession`; bumped on every new request via `onBumpChatNonce`. `onAppend` and `onSetLoading(false)` are no-ops if nonce is stale, preventing double responses and premature spinner-clear across retry/unmount races.
- **Scroll-to-bottom** — `prevLengthRef` guards scroll so it only fires when history grows, not on deletion.
- **Loading→submit ordering** — `onSetLoading(true)` fires before `onAppend([userTurn])` so both land in the same React render batch; no frame where spinner is absent but history ends on a user turn.
- **Tab-switch routing** — `targetTabId` is captured at submit time; `onAppend` and `onSetLoading` take explicit `targetTabId` so the response always routes to the originating tab even if `activeTabIdRef` has moved.
- **Q&A dividers** — `border-t` separates each Q&A block (before every user turn except the first).
- **Two-step delete** — per-turn delete requires a confirm.

### `ScoreBar`

Horizontal bar with label and percentage. Color thresholds:
- ≥ 70% → green
- 40–69% → yellow
- < 40% → red

---

## Shadcn UI Components (`src/components/ui/`)

Base primitives from Shadcn: `button`, `card`, `input`, `label`, `separator`, `spinner`, `switch`, `textarea`.
