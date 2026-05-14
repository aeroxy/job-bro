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

### `useChromeAiStatus`

Tracks the availability and download state of Chrome's built-in `LanguageModel`.

**State:** `status` (`unavailable` | `downloadable` | `downloading` | `available`), `downloadProgress` (0..1)

**Methods:** `refresh()` (re-query availability), `startDownload()` (trigger model download via `ensureChromeAiDownloaded`).

Subscribes to `onChromeDownloadProgress` on mount so any session creation in the app forwards progress here.

---

### `useChromeChatSession`

Persistent Chrome AI session for chat Q&A. Used by `ReportChat` when `useChromeBackend` is true.

**Returns:** `{ askChrome(systemPrompt, history, question, signal?), reset() }`

The session is created lazily on the first `askChrome` and **rebuilt** when the system prompt changes (different job/analysis) or when `history.length` doesn't match what the session has been told (e.g. after a Retry that drops the last assistant turn). On unmount the session is destroyed.

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
- **Backend selector** — two-card radio: "Cloud (HTTP)" vs "Chrome built-in AI". Chrome card is disabled when `useChromeAiStatus.status === 'unavailable'` and shows a hint about the `chrome://flags/#prompt-api-for-gemini-nano` requirement. When the backend is `chrome-prompt` and the model is `'downloadable'`, a Download button triggers `startDownload`; while `'downloading'`, a progress spinner with percent shows.
- **Cloud-only fields** (only when backend is `'openai'`): base_url, model, api_key (password show/hide), custom_headers (JSON textarea), request_timeout, stream_timeout
- **Stream Mode** switch — applies to both backends
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

**Backend dispatch:** Accepts `useChromeBackend`, `profile`, and `customPrompt` props. When `useChromeBackend` is true and `profile` is set, builds the chat system prompt locally via `buildChatSystemPrompt` and dispatches via `useChromeChatSession.askChrome` for an in-window stateful session. Otherwise sends a `CHAT_REQUEST` to the background worker (cloud path).

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
