# Libraries & Utilities

## `llm-client.ts`

LLM dispatcher. Routes to one of two backends based on `LLMConfig.backend`:
- `'openai'` (default) — OpenAI-compatible HTTP fetch.
- `'chrome-prompt'` — Chrome's built-in `LanguageModel` API (Gemini Nano), via [`chrome-prompt-client.ts`](#chrome-prompt-clientts).

### `chatCompletion(config, messages, options)`

If `config.backend === 'chrome-prompt'`, delegates to `chatCompletionChrome`. Otherwise makes a POST to `config.base_url + /chat/completions`.

Options:
- `json_mode: boolean` — sets `response_format: { type: "json_object" }`
- `temperature: number`
- `max_tokens: number`

**Retry behavior:**
- HTTP 429 / 5xx: retries with delays `[1000ms, 3000ms]`
- Network/abort errors: not retried
- Timeout: 30 seconds (AbortController)

**Custom headers:** `config.custom_headers` is parsed as JSON and merged into request headers.

---

### `parseJSON<T>(raw)`

Robust JSON parsing for LLM output:
1. Attempts direct `JSON.parse`
2. Strips Markdown code fences (` ```json ... ``` `)
3. Extracts outermost `{...}` or `[...]` block

---

### `validateNumbers(obj, fields)`

Asserts that all listed fields on `obj` are numbers in range 0–1. Throws on violation.

---

### `runWithValidation<T>(config, messages, validate)`

Calls `chatCompletion`, parses JSON, runs `validate`. On failure, appends the validation error as a user message and retries once.

---

### `buildMessages(customPrompt, internalPrompt, userContent)`

Assembles the `messages` array for a chat completion:
1. If `customPrompt` is set, prepends it to `internalPrompt` as the system message
2. Adds user content as final message

---

## `chrome-prompt-client.ts`

Adapter for Chrome's built-in `LanguageModel` API (Gemini Nano). **Window-context only** — calling these functions from the MV3 service worker will throw because `LanguageModel` is not exposed there. The API is accessed via `globalThis.LanguageModel` (latest Chrome spec).

| Export | Purpose |
|---|---|
| `chatCompletionChrome(messages, options)` | Same return contract as `chatCompletion`. Folds all `system` messages into a single concatenated initial prompt; sends prior turns via `initialPrompts`; sends the last user message via `session.prompt()`. JSON mode uses Chrome's `responseConstraint`. Streaming uses `promptStreaming()`. Sessions are created and destroyed per call. |
| `getChromeAiAvailability()` | Checks `globalThis.LanguageModel` existence, then wraps `LanguageModel.availability()` with a try/catch — returns `'unavailable'` if the global is missing. |
| `ensureChromeAiDownloaded(signal?)` | Checks `globalThis.LanguageModel` existence, then triggers a one-shot session create to start (or wait on) the model download. Progress events flow through `onChromeDownloadProgress`. |
| `onChromeDownloadProgress(listener)` | Subscribe to `downloadprogress` events broadcast from any session created via this module or via `chromeDownloadMonitor()`. Returns an unsubscribe fn. |
| `chromeDownloadMonitor()` | Returns a `monitor` function suitable for `LanguageModel.create({ monitor })`. Use it from any caller (e.g. the persistent chat session hook) so download progress reaches the same shared listeners. |

`max_tokens` has no equivalent in the Chrome API and is silently dropped — long resume generations may truncate.

---

## `llm-handlers.ts`

Shared orchestration callable from either the background service worker (HTTP backend) or the sidepanel window (Chrome backend). Pure functions — no `chrome.runtime` messaging here.

| Export | Returns | Used by |
|---|---|---|
| `runAnalysis(job, signal, onProgress?)` | `{ ok: true, report } \| { ok: false, error }` | `background.ts` (cloud), `useTabSessions.analyze` (chrome) |
| `runResume(job, analysisContext?, previousResume?, previousSummary?, comment?, qnaHistory?, signal?)` | `{ ok: true, markdown, summary } \| { ok: false, error }` | `background.ts` (cloud), `useTabSessions.generateResume`/`regenerateResume` (chrome) |
| `runChat(question, history, jobMarkdown, analysisContext)` | `{ ok: true, answer } \| { ok: false, error }` | `background.ts` (cloud) |
| `buildChatSystemPrompt(profile, jobMarkdown, analysisContext)` | `string` | `ReportChat` (Chrome chat path uses this with the persistent session hook) |

Each loads `profile`, `llmConfig`, and `customPrompt` from `chrome.storage.local` internally. Cloud backend additionally validates `base_url` + `model`; Chrome backend skips that check.

---

## `storage.ts`

Thin wrappers over `chrome.storage.local`:

| Function | Key |
|---|---|
| `getProfile()` / `saveProfile(p)` | `profile` |
| `getLLMConfig()` / `saveLLMConfig(c)` | `llmConfig` |
| `getCustomPrompt()` / `saveCustomPrompt(s)` | `customPrompt` |

---

## `db.ts`

IndexedDB via `idb` library. Database: `job-bro`, version 1.

**Object store:** `analyses`
- Key: auto-incremented `id`
- Indexes: `by-created` (on `createdAt`), `by-company` (on `job.company`)

| Function | Description |
|---|---|
| `saveAnalysis(record)` | Upserts record |
| `listAnalyses()` | Returns all records sorted by `createdAt` desc |
| `getAnalysis(id)` | Fetches single record |
| `deleteAnalysis(id)` | Removes record |
| `clearAnalyses()` | Deletes all records |

---

## `download.ts`

| Function | Description |
|---|---|
| `downloadMarkdown(markdown, filename)` | Creates a `text/markdown` Blob and triggers browser download |
| `downloadPDF(html, title)` | Opens a print-ready HTML page in a new window and calls `window.print()` |
| `makeFilename(company, title, ext)` | Sanitizes inputs, joins with `_`, appends extension |

---

## `extractor/linkedin.ts`

LinkedIn DOM parser. Runs inside the content script.

**Key selectors:**
- Container: `[data-testid="lazy-column"]` (LinkedIn 2025 DOM)
- Falls back to `document.title` if title parsing fails

**Parsing helpers:**
- `extractSalary()` — regex-based salary pattern matching
- `extractEmploymentType()` — matches against known employment type strings
- `extractExperienceLevel()` — matches against known level strings
- `parseListsFromDescription()` — splits job description into requirements/benefits by section headers (case-insensitive keyword matching)

---

## `extractor/markdown.ts`

`jobToMarkdown(job: ExtractedJob): string`

Converts an `ExtractedJob` to a Markdown document for LLM prompts. Includes all fields: URL, title, company, location, salary, employment type, experience level, description, requirements, benefits.

---

## `utils.ts`

`cn(...inputs)` — Combines `clsx` and `tailwind-merge` for conditional class composition.
