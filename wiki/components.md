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

Chrome's Prompt API is accessed via `globalThis.LanguageModel` (latest spec).

---

### `useTabSessions`

Main hook for managing tab-scoped analysis sessions. Handles session state (analysis reports, chat history, resume generation), tab lifecycle (syncing on navigation, cleaning up on close), and multi-tab job coordination (sharing results between tabs viewing the same job).

**State:** `TabSession` per tab — `view`, `status`, `job`, `report`, `error`, `progress`, `resumeStatus`, `resumeMarkdown`, `resumeSummary`, `resumeError`, `qnaHistory`, `chatLoading`, `chatNonce`, `hydratedJobId`

**AbortController refs:**
- `localAnalysisControllersRef` — `Map<number, AbortController>` for analysis tasks (Chrome backend)
- `localResumeControllersRef` — `Map<number, AbortController>` for resume tasks (Chrome backend)

These are kept separate so cancelling a resume doesn't cancel an in-flight analysis, and vice versa.

**Key methods:**
- `analyze(tabId, job)` — runs `runAllEvaluators` (Chrome backend) or sends `ANALYZE_JD` (cloud backend)
- `generateResume(tabId, job, analysisContext)` — runs `runResume` locally or sends `GENERATE_RESUME` with `tabId`
- `regenerateResume(tabId, job, comment)` — re-runs with previous markdown + cumulative changelog
- `cancelAnalysis(tabId)` — aborts local controller + sends `CANCEL_ANALYSIS` to background
- `cancelResume(tabId)` — aborts local controller + sends `CANCEL_RESUME` to background
- `resetResume(tabId)` — clears resume state back to idle

**Cross-tab sync:** When a tab is closed or a process is cancelled, sibling tabs viewing the same `job_id` gracefully reset to `idle` state. The `onTabRemoved` callback set cascades cleanup across all registered listeners.

**Shared generation helper:** `runResumeGeneration()` encapsulates controller lifecycle, deduplication (prevents concurrent generations for the same tab), and error mapping for both generate and regenerate flows.

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
- **Backend selector** — three-card radio: "Cloud" (`openai` **or** `anthropic`) / "Chrome" (`chrome-prompt`, Gemini Nano) / "Qwen Chat" (`qwen-chat`). Chrome card is disabled when `useChromeAiStatus.status === 'unavailable'` and shows a hint about the `chrome://flags/#prompt-api-for-gemini-nano` requirement. When the backend is `chrome-prompt` and the model is `'downloadable'`, a Download button triggers `startDownload`; while `'downloading'`, a progress spinner with percent shows. Re-clicking Cloud preserves an Anthropic profile's format rather than resetting it to `openai`.
- **Cloud fields** (`providerMode === 'api'`, i.e. `'openai'` or `'anthropic'`): **API Format** toggle, base_url, model, api_key (password show/hide), custom_headers (JSON textarea), request_timeout, stream_timeout, **concurrency**, max_tokens, temperature; plus Allow Tool Calls / Structured Output / Stream Mode switches.
- **API Format toggle** — two cards inside the Configuration section: "OpenAI" (`/chat/completions`) / "Anthropic" (`/messages`). Anthropic is a *wire format of the cloud provider*, not a separate backend in the UI, because the two share every field below and the same profile list — a top-level tile made OpenAI-configured profiles look mis-filed under Anthropic. It writes `config.backend`, which is still what `llm-client` dispatches on, so the format is saved per profile.
- **Anthropic differences** (`isAnthropic`): base_url/model placeholders become `https://api.anthropic.com/v1` / `claude-opus-5`; the Structured Output blurb names `output_config.format`; the Stream Mode switch is hidden (that path always streams) and the timeout hints flip so "Stream Timeout" is the live one. A note under the toggle explains the `x-api-key` + `x-claude-code-session-id` headers and links claude-proxy. The session id is stable **per LLM profile**, not per job: cache entries are partitioned by session, and each evaluator's system block is job-independent (the JD rides in a user turn), so one partition per profile lets a later posting read the ~21k system block instead of rewriting it. See [`lib.md` → `llm-handlers.ts`](lib.md#llm-handlersts).
- **Qwen-only fields** (only when backend is `'qwen-chat'`): Auth Status (token check), Device Identity (device ID + rotating `ssxmod_itna` fingerprint, Update button), **Model** picker (`config.qwenModel`, one of `QWEN_MODELS`: `qwen3.8-max` / `qwen3.7-max` / `qwen3.7-plus`, normalized via `normalizeQwenModel` with fallback to `QWEN_MODELS[0]`), and **Concurrency** — caps how many evaluators hit `chat.qwen.ai` in parallel (`config.concurrency ?? 2`); lowering to 1 mitigates the anti-bot "overloaded" throttle.
- Large textarea: custom system prompt (prepended to all evaluators; saved per-profile for cloud/Qwen, separate key for Chrome).

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
