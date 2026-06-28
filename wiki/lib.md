# Libraries & Utilities

## `llm-client.ts`

LLM dispatcher. Routes to one of three backends based on `LLMConfig.backend`:
- `'openai'` (default) — OpenAI-compatible HTTP fetch to a cloud model.
- `'chrome-prompt'` — Chrome's built-in `LanguageModel` API (Gemini Nano), via [`chrome-ai-client.ts`](#chrome-ai-clientts).
- `'qwen-chat'` — **Delegated agent**, not a model. Calls into [`qwen/qwen-service.ts`](#qwenqwen-servicets), which drives the user's live `chat.qwen.ai` session. Qwen runs its own native web search, read-page, and thinking on the server side — the extension's `WEB_SEARCH_TOOL` / `READ_PAGE_TOOL` are not sent. `chatCompletion` is reused as the dispatch entry point for API symmetry, but on this branch the semantics are "delegate task to agent", not "prompt a model".

The dispatcher is pure TS and runs in the service worker. Cloud and Chrome are addressed via the same `chatCompletion` / `chatCompletionWithTools` surface; Chrome's window-only `LanguageModel` lives in the offscreen and is reached through `chrome-ai-client`. The Qwen branch is reached from the offscreen via a `QWEN_CHAT_REQUEST` message bridge to the background (the offscreen has no `chrome.cookies`).

### `chatCompletion(config, messages, options)`

Dispatch priority order:
1.  `chrome-prompt` → `chatCompletionChrome`.
2.  `qwen-chat` → `sendQwenChat` via the Qwen agent service (bridged through the background when called from the offscreen).
3.  Otherwise → POST to `config.base_url + /chat/completions`.

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

Non-streaming tool-call variant for the **Cloud** backend. Same HTTP plumbing, but `tools` is forwarded as `body.tools` and the response may include `tool_calls`. Returns a `ChatCompletionWithToolsResult` (`{ content, tool_calls, raw }`). The `role` of `ChatMessage` extends to include `'tool'` (with `tool_call_id` and `name` for tool results).

Two backends short-circuit here:

- **Chrome** — `resolveOutput` routes it to the inline-prompt path (Gemini Nano has no native tool API and ignores `response_format.json_schema`), so Chrome arrives with `tools = []`. Returns `{ content }` from a single `chatCompletion` call — the agent loop terminates after one iteration.
- **Qwen** — Qwen is an *agent* with server-side tools, not a model that calls ours. Forwarding our `WEB_SEARCH_TOOL` / `READ_PAGE_TOOL` schemas would be meaningless and confuse its prompt, so this function short-circuits to `chatCompletion` and returns `{ content }`. Research is done server-side by Qwen itself.

Cloud is the only path that genuinely participates in the OpenAI tool-calling protocol.

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

## `qwen/qwen-service.ts`

**Delegated agent** backend, not a model. When `config.backend === 'qwen-chat'`, the extension hands the whole research task off to the user's live `chat.qwen.ai` session and receives a finished answer back. Qwen runs its own native **web search**, **read-page**, and **thinking** on the server side — so the extension's `WEB_SEARCH_TOOL` / `READ_PAGE_TOOL` research tools and the `provide_verdict` structured-output channel are irrelevant on this path. `resolveOutput` in `evaluators/runner.ts` routes Qwen to the inline-prompt strategy (no schema, no verdict channel), and `chatCompletionWithTools` short-circuits to `chatCompletion`.

Why it exists: lets users run evaluations without an API key or a self-hosted proxy, using only their authenticated Qwen browser session.

| Export | Purpose |
|---|---|
| `getQwenToken()` | Retrieves the active JWT — first from the `token` cookie on `chat.qwen.ai`, falling back to `chrome.scripting.executeScript` against an open `chat.qwen.ai` tab to pull it from localStorage. |
| `updateQwenCookies()` | Generates fresh `ssxmod_itna` / `ssxmod_itna2` security cookies via [`cookie-generator.ts`](#qwencookie-generatorts) and writes them to the cookie jar. Called before every completions request. |
| `createQwenSession(token)` | `POST /api/v2/chats/new` — opens a new chat on the user's account and returns the `chat_id`. |
| `sendQwenChat(messages, signal?)` | Non-streaming wrapper around `sendQwenChatStream` that accumulates chunks and resolves to the final string. |
| `sendQwenChatStream(messages, onChunk, onDone, onError, signal?)` | Streams SSE from `POST /api/v2/chat/completions`. Refreshes security cookies, retrieves the token, opens a session, then decodes deltas in real time. A 10-second keep-alive ping (`QWEN_PING` to background) keeps the service worker alive during long responses. |

Supporting modules:

### `qwen/cookie-generator.ts`

LZW-compresses and custom-base64-encodes a 37-field fingerprint into the `ssxmod_itna` / `ssxmod_itna2` cookies Qwen's anti-bot checks require. Hash fields are re-randomized on every call; the timestamp field is refreshed to `Date.now()`.

### `qwen/fingerprint.ts`

Generates the default 37-field template (device id, SDK version, platform, screen info, WebGL renderer, etc.) with presets for `macIntel` / `macM1` / `win64` / `linux` and common screen sizes.

Execution context: the service uses `chrome.cookies` and `chrome.declarativeNetRequest`, which the offscreen document can't reach. `chatCompletion` in `llm-client.ts` detects the offscreen context (`!chrome.cookies`) and bridges the call to the background via `QWEN_CHAT_REQUEST`; the background handler forwards to `sendQwenChat`.

### Known limitations

**Offscreen abort signals don't propagate to the background.** When `chatCompletion` is called from the offscreen (the typical evaluator path), the `options.signal` is not forwarded across the `QWEN_CHAT_REQUEST` message — `AbortSignal` is a live object tied to the originating process's event loop and cannot be serialized through `chrome.runtime.sendMessage`. Current behavior:

- The offscreen side awaits the response; if the caller aborts locally, the `await` rejects but the background fetch continues to completion.
- If the user closes the tab or triggers `CANCEL_ANALYSIS`, the offscreen's controller is aborted but the in-flight background fetch is orphaned until Qwen's server closes the SSE stream or the service worker is recycled.

A proper implementation would need:
1.  A request-id field in `QWEN_CHAT_REQUEST`.
2.  An `AbortController` registry in the background keyed by that id.
3.  A new `QWEN_CANCEL_REQUEST` message type; the offscreen posts it when its local signal aborts.
4.  The background resolves the matching controller and calls `.abort()`, threading it into the fetch `signal`.

Tracked as deferred work; low-priority because orphaned fetches are bounded by Qwen's stream length and the service worker's lifecycle.

---

## `agent.ts`

Agent loop driver. Replaces the old `runWithValidation` for evaluator output. Lives in the service worker (or any extension page — it's pure TS).

**Only the Cloud backend genuinely participates in the tool-calling loop.** Chrome short-circuits here because `resolveOutput` routes it to the inline-prompt path (Gemini Nano has no native tool API). Qwen short-circuits because it is itself an agent — forwarding our tool schemas would be meaningless.

| Export | Purpose |
|---|---|
| `runAgent(config, messages, tools, handlers, options)` | Drives an OpenAI-style tool-calling loop: model → tool calls → append results → loop. Caps at `MAX_AGENT_ITERATIONS = 10`; research tools are stripped after `MAX_TOOL_ROUNDS = 5`. When `options.verdictName` is set, the matching `provide_verdict` call is intercepted as the in-house structured-output channel: its arguments become the returned JSON content, siblings are dropped from history, and the loop ends. If the model emits plain text instead of calling it, a nudge message is appended and the loop continues. |
| `runAgentWithValidation<T>(config, messages, tools, handlers, validate, options)` | Wraps `runAgent` with a JSON-extract + validate step. On validation failure, appends the errors as a `role: 'tool'` message (referencing the `provide_verdict` call's `tool_call_id` when the structured-output channel is in play, otherwise a plain-text user turn) and re-runs the agent so the correction flows through the same channel. |
| `executeTool(call, handlers, context)` | Generic dispatcher: looks up the tool by name in `handlers`, calls it with parsed args, returns the result. |
| `ToolHandlerContext` | `{ signal: AbortSignal }` passed to handlers so they can compose with the caller's timeout. |

`handlers` is a `Map<string, ToolHandler>` (`(args, context) => Promise<unknown>`). Adding a new tool is: (1) add the schema in `tools/definitions.ts`, (2) add a handler in `tools/handlers.ts`, (3) register in the evaluator's `handlers` map. All 5 evaluators + summary use the same `ALL_TOOLS` set + a shared handler map built once per analysis.

---

## `tools/`

Tool definitions + handlers, shared across evaluators.

### `types.ts`
`ToolDefinition` (function-calling schema), `ToolCall`, `ToolHandler`, `ToolHandlerContext`, `ChatCompletionWithToolsResult`.

### `definitions.ts`
Two research tools (the only definitions that have handlers in `handlers.ts` and produce tool results the model reads):
- `WEB_SEARCH_TOOL` — `{ query: string }`. Run by the service worker: fetch `https://html.duckduckgo.com/html?q=...`, then `PARSE_HTML` to offscreen.
- `READ_PAGE_TOOL` — `{ url: string }`. Fetch (with `AbortSignal.timeout(20s)`), then `PARSE_HTML`.
- `ALL_TOOLS` — array of the two research tools above. Passed to every evaluator's `chatCompletionWithTools` call.

**In-house structured-output channel** (NOT a tool — no handler, no execution, no result the model reads):
- `VERDICT_NAME = 'provide_verdict'` — the wire-format name the agent loop watches for.
- `buildVerdictSchema(evaluatorSchema)` → a fake tool declaration whose `parameters` ARE the evaluator's JSON schema. Used by `resolveOutput` in `evaluators/runner.ts` on the non-strict path (path 3). The model "calls" it, and the agent loop intercepts the call's `arguments` string as the final structured answer. Exists because strict `response_format.json_schema` is mutually exclusive with `tool_calls` on most providers, so tool-using evaluators can't also use it. Survives `MAX_TOOL_ROUNDS` (research tools are stripped; this remains), with the nudge loop forcing the call while `tool_choice` stays `'auto'`.

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

IndexedDB via `idb` library. Database: `job-bro`, version 4.

**v4 migration (backfill):** `extractLinkedInJobId` once returned `null` for slug-style `/jobs/view/<slug>-<id>/` URLs, so analyses extracted on those pages were stored with `job_id=undefined` and never got a `sessions` row — the panel couldn't rehydrate them. The v4 upgrade re-derives `job_id` from each affected `analyses` record's `job.url`, patches the record, and synthesizes the missing `sessions` row (newest report per job; never clobbers an existing session).

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

## `extractor/site.ts`

Site-adapter dispatcher — the single entry point consumers use so the app is
job-board-agnostic. Picks the right adapter (LinkedIn / Greenhouse) by URL.

| Export | Purpose |
|---|---|
| `extractJobId(url)` | URL → stable, **site-namespaced** `job_id`. LinkedIn stays bare-numeric (`4417162348`); Greenhouse is prefixed `gh:` (`gh:4593216008`) so the two never collide in the `sessions` store. Tries LinkedIn then Greenhouse; the per-site matchers are disjoint. Used by hydration (`useTabSessions`), history tab-matching (`useHistory`), and background gating. |
| `isSupportedJobUrl(url)` | `extractJobId(url) !== null`. |
| `waitForJobPage(timeoutMs)` | Page-context (content script only). Dispatches to the matching adapter's page-ready poll. |
| `extractJobFromPage()` | Page-context. Dispatches to the matching adapter's DOM extractor. |

## `extractor/greenhouse.ts`

Greenhouse DOM parser (`job-boards.greenhouse.io` + `boards.greenhouse.io`). Runs inside the content script.

**Key selectors:** `h1.section-header` (title, falls back to `meta[og:title]`), `.job__location` (location), `.job__description` (description via `innerText`). Company is parsed from `document.title` (`"Job Application for <title> at <Company>"`, using the last ` at `), falling back to the capitalized org slug in the URL path.

`extractGreenhouseJobId(url)` returns `gh:<id>` from `.../<org>/jobs/<id>`; `isGreenhouseJobUrl(url)` gates dispatch.

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
