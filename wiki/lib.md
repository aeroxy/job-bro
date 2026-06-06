# Libraries & Utilities

## `llm-client.ts`

LLM dispatcher. Routes to one of two backends based on `LLMConfig.backend`:
- `'openai'` (default) — OpenAI-compatible HTTP fetch.
- `'chrome-prompt'` — Chrome's built-in `LanguageModel` API (Gemini Nano), via [`chrome-ai-client.ts`](#chrome-ai-clientts).

The dispatcher is pure TS and runs in the service worker. Both backends are addressed via the same `chatCompletion` / `chatCompletionWithTools` surface; Chrome's window-only `LanguageModel` lives in the offscreen and is reached through `chrome-ai-client`.

### `chatCompletion(config, messages, options)`

If `config.backend === 'chrome-prompt'`, delegates to `chatCompletionChrome`. Otherwise makes a POST to `config.base_url + /chat/completions`.

Options:
- `json_mode: boolean` — sets `response_format: { type: "json_object" }`
- `temperature: number` — resolved as `options.temperature ?? config.temperature`. Omitted from the request body entirely when unset, so the provider applies its own default (some reasoning models reject/ignore an explicit temperature).
- `max_tokens: number` — resolved as `options.max_tokens ?? config.max_tokens ?? 8192`. The default is deliberately high: reasoning models count `reasoning_content` against `max_tokens`, so a low budget gets fully consumed by reasoning, returning empty content with `finish_reason: 'length'`.

**Truncation handling:** when the response has `finish_reason: 'length'` and no usable output (empty content, no tool_calls), the client throws an actionable error ("Raise Max Tokens in settings") instead of returning `''` and tripping a downstream JSON parse error. Applies to all three paths (non-stream, tools, stream).

**Retry behavior:**
- HTTP 429 / 5xx: retries with delays `[1000ms, 3000ms]`
- Network/abort errors: not retried
- Timeout: 30 seconds (AbortController)

**Custom headers:** `config.custom_headers` is parsed as JSON and merged into request headers.

### `chatCompletionWithTools(config, messages, tools, options)`

Non-streaming tool-call variant. Same HTTP plumbing, but `tools` is forwarded as `body.tools` and the response may include `tool_calls`. Returns a `ChatCompletionWithToolsResult` (`{ content, tool_calls, raw }`). The `role` of `ChatMessage` extends to include `'tool'` (with `tool_call_id` and `name` for tool results). Chrome backend passes through with no `tools` (Gemini Nano has no native tool API) and returns the same shape with `tool_calls: []`, so the agent loop terminates after one iteration.

---

### `parseJSON<T>(raw)`

Robust JSON parsing for LLM output:
1. Strips a Markdown code fence (` ```json ... ``` `) or isolates the outermost `{...}` block
2. Attempts `JSON.parse`
3. On failure, falls back to `jsonrepair` (fixes unescaped quotes/newlines, trailing commas, truncated tails) before throwing a descriptive error

---

### `validateNumbers(obj, fields)`

Asserts that all listed fields on `obj` are numbers in range 0–1. Throws on violation.

---

## `chrome-ai-client.ts`

Thin messaging client for the Chrome AI work that lives in the offscreen document. Pure sidepanel/service-worker code — never touches `globalThis.LanguageModel` itself. The offscreen holds the one in-process model instance and serializes calls through a FIFO queue.

| Export | Purpose |
|---|---|
| `chatCompletionChrome(messages, options)` | One-shot completion; builds a fresh session per call, folds systems into one initial prompt, sends the last user message. Returns `string`. |
| `getChromeAiAvailability()` | Wraps the offscreen's `CHROME_AI_AVAILABILITY`; returns `'unavailable' \| 'downloadable' \| 'downloading' \| 'available'`. |
| `ensureChromeAiDownloaded(signal?)` | Triggers a model download via offscreen; awaits completion. |
| `onChromeDownloadProgress(listener)` | Subscribe to `CHROME_AI_DOWNLOAD_PROGRESS` broadcasts (one shared listener set per call). Returns an unsubscribe fn. |
| `createChromeAiSession({ systemPrompt, history, temperature })` | Returns a `sessionId` string for a persistent session stored in offscreen's `Map`. |
| `promptChromeAiSession(sessionId, content, { signal })` | Issues a turn on a persistent session. |
| `destroyChromeAiSession(sessionId)` | Destroys and removes the session. |

`SYSTEM_PROMPT_SEPARATOR` is exported for the chat prompt builder that needs to mark where the per-turn context begins inside a long system prompt.

---

## `agent.ts`

Agent loop driver. Replaces the old `runWithValidation` for evaluator output. Lives in the service worker (or any extension page — it's pure TS).

| Export | Purpose |
|---|---|
| `runAgent(config, messages, tools, handlers, options)` | Drives an OpenAI-style tool-calling loop: model → tool calls → append results → loop. Caps at `MAX_AGENT_ITERATIONS = 8`. Returns the final `ChatCompletionWithToolsResult`. |
| `runAgentWithValidation<T>(config, messages, tools, handlers, validate, options)` | Wraps `runAgent` with a JSON-extract + Zod-style validate step. On validation failure, appends the errors as a user message and continues the loop (or retries once before throwing). |
| `executeTool(call, handlers, context)` | Generic dispatcher: looks up the tool by name in `handlers`, calls it with parsed args, returns the result. |
| `ToolHandlerContext` | `{ signal: AbortSignal }` passed to handlers so they can compose with the caller's timeout. |

`handlers` is a `Map<string, ToolHandler>` (`(args, context) => Promise<unknown>`). Adding a new tool is: (1) add the schema in `tools/definitions.ts`, (2) add a handler in `tools/handlers.ts`, (3) register in the evaluator's `handlers` map. All 5 evaluators + summary use the same `ALL_TOOLS` set + a shared handler map built once per analysis.

---

## `tools/`

Tool definitions + handlers, shared across evaluators.

### `types.ts`
`ToolDefinition` (function-calling schema), `ToolCall`, `ToolHandler`, `ToolHandlerContext`, `ChatCompletionWithToolsResult`.

### `definitions.ts`
Two tools, both OpenAI-compatible function-calling schemas:
- `WEB_SEARCH_TOOL` — `{ query: string }`. Run by the service worker: fetch `https://html.duckduckgo.com/html?q=...`, then `PARSE_HTML` to offscreen.
- `READ_PAGE_TOOL` — `{ url: string }`. Fetch (with `AbortSignal.timeout(20s)`), then `PARSE_HTML`.
- `ALL_TOOLS` — the array passed to every evaluator's `chatCompletionWithTools` call.

### `handlers.ts`
`webSearch` and `readPage` — fetch in the service worker, send HTML to offscreen for the Turndown conversion, return the resulting markdown. Both honor `context.signal` for caller aborts.

---

## `html-to-markdown.ts`

Shared HTML→markdown pipeline used by the offscreen to service the agent tools. The offscreen uses Turndown directly (window-only); the tool handlers don't parse, they just call the offscreen.

| Export | Purpose |
|---|---|
| `parseHtmlToMarkdown(html)` | Strips `<script>`/`<style>`/`<noscript>`, runs Turndown on the rest. Returns `{ markdown, trimmed: false }`. Single function — no mode-specific variants; both `web_search` and `read_page` get the same treatment. |
| `stripScriptsAndStyles(html)` | Internal helper. |

---

## `llm-handlers.ts`

Orchestration glue. Always runs in the service worker. The Chrome backend now flows through `chrome-ai-client` instead of calling `LanguageModel` directly.

| Export | Returns | Used by |
|---|---|---|
| `runAnalysis(job, signal, onProgress?)` | `{ ok: true, report } \| { ok: false, error }` | `background.ts` |
| `runResume(job, analysisContext?, previousResume?, previousSummary?, comment?, qnaHistory?, signal?)` | `{ ok: true, markdown, summary } \| { ok: false, error }` | `background.ts` |
| `runChat(question, history, jobMarkdown, analysisContext)` | `{ ok: true, answer } \| { ok: false, error }` | `background.ts` |
| `buildChatSystemPrompt(profile, jobMarkdown, analysisContext)` | `string` | `ReportChat` (used by `useChromeChatSession` on the Chrome path) |

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

IndexedDB via `idb` library. Database: `job-bro`, version 2.

**Object store:** `sessions`
- Key: LinkedIn `job_id` (string)
- Indexes: `by-updated` (on `updatedAt`)
- Holds `PersistedSession[]` — live UI state + history source (Q&A, analysis, resume). Replaces the older `analyses` v1 store.

| Function | Description |
|---|---|
| `saveSession(session)` | Upserts by `job_id` |
| `listSessions()` | Returns all records sorted by `updatedAt` desc |
| `getSession(jobId)` | Fetches single record |
| `deleteSession(jobId)` | Removes record |
| `clearSessions()` | Deletes all records |

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
