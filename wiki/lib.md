# Libraries & Utilities

## `llm-client.ts`

LLM dispatcher. Routes to one of four backends based on `LLMConfig.backend`:
- `'openai'` (default) — OpenAI-compatible HTTP fetch to a cloud model.
- `'anthropic'` — Anthropic Messages API (`POST {base_url}/messages`): the API itself, a gateway, or a local [claude-proxy](https://github.com/aeroxy/claude-proxy). Same bring-your-own-key shape as `'openai'`; only the wire format differs, and [`anthropic-messages.ts`](#anthropic-messagests) translates it. Always streams.
- `'chrome-prompt'` — Chrome's built-in `LanguageModel` API (Gemini Nano), via [`chrome-ai-client.ts`](#chrome-ai-clientts).
- `'qwen-chat'` — **Delegated agent**, not a model. Calls into [`qwen/qwen-service.ts`](#qwenqwen-servicets), which drives the user's live `chat.qwen.ai` session. Qwen runs its own native web search, read-page, and thinking on the server side — the extension's `WEB_SEARCH_TOOL` / `READ_PAGE_TOOL` are not sent. `chatCompletion` is reused as the dispatch entry point for API symmetry, but on this branch the semantics are "delegate task to agent", not "prompt a model".

The dispatcher is pure TS and runs in whichever realm calls it — it is not service-worker-bound:

| Flow | Realm |
|---|---|
| Analysis / resume, any backend but `chrome-prompt` | **Offscreen document.** The sidepanel sends `ANALYZE_JD` to the background, which relays it as `OFFSCREEN_ANALYZE_JD`; the offscreen runs `runAnalysis` end to end, free of service-worker lifetime limits — which is also what lets the Anthropic path hold an SSE stream open through a long think. |
| Analysis / resume, `chrome-prompt` | **Sidepanel window**, locally (`useTabSessions` imports `runAnalysis` directly). |
| Chat | **Service worker** (`CHAT_REQUEST` → `runChat`), except on `chrome-prompt`, which the sidepanel handles itself. |

Cloud, Anthropic and Chrome are addressed via the same `chatCompletion` / `chatCompletionWithTools` surface; Chrome's window-only `LanguageModel` lives in the offscreen and is reached through `chrome-ai-client`. The Qwen branch is reached from the offscreen via a `QWEN_CHAT_REQUEST` message bridge to the background (the offscreen has no `chrome.cookies`).

### `chatCompletion(config, messages, options)`

Dispatch priority order:
1.  `chrome-prompt` → `chatCompletionChrome`.
2.  `qwen-chat` → `sendQwenChat` via the Qwen agent service (bridged through the background when called from the offscreen). `config.qwenModel` (optional, one of `QWEN_MODELS`) is normalized via `normalizeQwenModel` (fallback `QWEN_MODELS[0]`) at this boundary and forwarded to the background as `qwenModel`, then threaded through `createQwenSession` / `sendQwenChatStream` / `buildQwenMessagesPayload`.
3.  `anthropic` → `anthropicRequest` (queued like Cloud), which streams `config.base_url + /messages`. `json_mode` has no equivalent and is ignored — JSON shape comes from the prompt, the strict `output_config.format` path, or the `provide_verdict` channel.
4.  Otherwise → POST to `config.base_url + /chat/completions`.

Options:
- `json_mode: boolean` — sets `response_format: { type: "json_object" }`
- `temperature: number` — resolved as `options.temperature ?? config.temperature`. Omitted from the request body entirely when unset, so the provider applies its own default (some reasoning models reject/ignore an explicit temperature).
- `max_tokens: number` — resolved as `options.max_tokens ?? config.max_tokens ?? 8192`. The default is deliberately high: reasoning models count `reasoning_content` against `max_tokens`, so a low budget gets fully consumed by reasoning, returning empty content with `finish_reason: 'length'`.

**Truncation handling:** when the response has `finish_reason: 'length'` and no usable output (empty content, no tool_calls), the client throws an actionable error ("Raise Max Tokens in settings") instead of returning `''` and tripping a downstream JSON parse error. Applies to all three paths (non-stream, tools, stream).

**Retry behavior:** one policy, shared by all four HTTP loops (non-stream, stream, tools, Anthropic SSE) via the module-level `HTTP_RETRY_DELAYS` / `RETRYABLE_STATUS` / `isRetryableStatus`.
- HTTP 429 / 500 / 502 / 503 / 504 / 529: retried with delays `[3s, 10s]` — 3 attempts total. 529 is Anthropic's `overloaded_error`; 408 is deliberately excluded (an intermediary's request timeout says nothing about whether a replay is safe).
- Transient network errors (`fetch` `TypeError`, our own `TimeoutError`): retried on the same schedule. A **user abort** (`signal.aborted`) and the `Error`s this module throws itself are not.
- **Anthropic only:** a failure is additionally only retried while no SSE event has been delivered yet — see `postSSE` below.

**Timeouts** differ per transport:
- Non-streaming (`openai`): `config.timeout ?? 30` s, total, per attempt.
- Streaming (`openai` with `stream_mode`, and always on `anthropic`): `config.stream_timeout ?? 60` s of **inactivity between chunks**, rearmed on every chunk, so a long think doesn't trip it. `config.timeout` is unused on those paths.

**Custom headers:** `config.custom_headers` is parsed as JSON and merged into request headers.

**Concurrency:** both Cloud and Qwen go through the per-provider `RequestQueue` (`getQueue(key).run(concurrency, fn)`), `config.concurrency ?? 2`. Cloud keys by `base_url`; Qwen keys by the constant `'qwen-chat'` (it has no `base_url`). The queue lives in the calling realm — for the analysis path that's the **offscreen**, so it caps how many of the 6 evaluators hit `chat.qwen.ai` in parallel before they fan out to the background via `QWEN_CHAT_REQUEST`. This is the primary defense against Qwen's anti-bot burst throttle; a request mid-back-off (see anti-bot retry below) keeps holding its slot, applying backpressure. Chrome (`chrome-prompt`) is serialized separately by the offscreen's own FIFO and skips this queue.

### `chatCompletionWithTools(config, messages, options)`

Tool-call variant for the keyed HTTP backends. Tools arrive in `options.tools` (alongside `tool_choice`, `jsonSchema`, `signal`, `temperature`, `max_tokens`) — there is no separate `tools` argument. On **Cloud** the call is non-streaming and `options.tools` is forwarded as `body.tools`; on **Anthropic** it streams and the tools are translated to Anthropic's `input_schema` shape. Either way the response may include `tool_calls`, returned as a `ChatCompletionWithToolsResult` (`{ content, tool_calls?, reasoning_blocks? }`). The `role` of `ChatMessage` extends to include `'tool'` (with `tool_call_id` for tool results).

Two backends short-circuit here:

- **Chrome** — `resolveOutput` routes it to the inline-prompt path (Gemini Nano has no native tool API and ignores `response_format.json_schema`), so Chrome arrives with `tools = []`. Returns `{ content }` from a single `chatCompletion` call — the agent loop terminates after one iteration.
- **Qwen** — Qwen is an *agent* with server-side tools, not a model that calls ours. Forwarding our `WEB_SEARCH_TOOL` / `READ_PAGE_TOOL` schemas would be meaningless and confuse its prompt, so this function short-circuits to `chatCompletion` and returns `{ content }`. Research is done server-side by Qwen itself.

Cloud and Anthropic are the two paths that genuinely tool-call; Anthropic's `tool_use` blocks are re-serialised as OpenAI-shaped `tool_calls`, so `lib/agent.ts` and the `provide_verdict` channel work unchanged.

---

### `anthropicRequest(config, messages, bodyOptions, signal)`

The Anthropic transport, private to `llm-client.ts`. Both `chatCompletion` and `chatCompletionWithTools` funnel into it, inside the same per-`base_url` `RequestQueue` the Cloud path uses.

**Always streams**, even though nothing consumes the deltas: it makes the timeout idle-based (`config.stream_timeout ?? 60`, rearmed per chunk) rather than total, so a model that thinks for minutes — Claude Opus 5 has thinking on by default — can't trip it while a dead connection still does. `config.stream_mode` is therefore irrelevant here and its switch is hidden in Settings; `config.timeout` is unused.

Headers:
- `anthropic-version: 2023-06-01`
- `anthropic-dangerous-direct-browser-access: true` — `api.anthropic.com` refuses browser-origin requests without it; endpoints that don't check ignore it.
- `x-api-key: config.api_key` (not a bearer token)
- `x-claude-code-session-id: config.session_id` when set — see [`llm-handlers.ts`](#llm-handlersts).
- plus `config.custom_headers`.

`postSSE` is the streaming sibling of the other paths' fetch loops: same `[3s, 10s]` retry on 429/5xx and transient network errors, but a failure is only retried **while nothing has been delivered** — once events are out, replaying would duplicate accumulated state. It parses blank-line-separated SSE blocks (CRLF tolerant), flushes the decoder tail at end-of-stream so the last event isn't dropped, and cancels the reader on every exit path. A `type: 'error'` event throws immediately (still from a retryable position).

A non-2xx body is unwrapped by `anthropicErrorText` before it becomes an `Error`: Anthropic answers `{"type":"error","error":{"type","message"}}`, and the envelope would otherwise land verbatim in the sidepanel's error card, burying the one useful sentence (most visibly for the 400s a user can cause — an explicit `temperature`, an unsupported `output_config`). A non-JSON body, e.g. a gateway's HTML page, passes through unchanged.

After the stream, `stop_reason: 'refusal'` throws with the `stop_details` category/explanation. An empty result is then split by stop reason: `max_tokens` throws the shared truncation message ("raise Max Tokens"), while `model_context_window_exceeded` throws its own — the *input* filled the window, so raising Max Tokens makes it worse, and the fix is a shorter profile or a bigger model.

`options.json_mode` is deliberately dropped on this path. It maps to OpenAI's schema-less `response_format: {type:'json_object'}`, which the Messages API has no equivalent for — structured output there is `output_config.format` with a full schema, which *is* sent when a caller supplies `jsonSchema`. Every current caller of `chatCompletion` passes `json_mode: false`.

---

### `anthropic-messages.ts`

Pure translation between the OpenAI-shaped `ChatMessage` / `ToolDefinition` types and Anthropic's Messages API. No fetch, no retry — that policy stays in `llm-client.ts`.

- `toAnthropicMessages` — hoists `system` turns into the top-level field (Anthropic rejects a system message anywhere else), turns `tool` turns into `tool_result` blocks on a **user** turn, and assistant `tool_calls` into `tool_use` blocks. Same-role turns are merged, which is what puts a whole round of parallel tool results into one user turn — splitting them teaches the model to stop calling tools in parallel. If the result *ends* on an assistant turn, its last text block is `trimEnd`ed: Anthropic reads a trailing assistant turn as a prefill and rejects one ending in whitespace. No current caller does that (the agent loop always appends a tool result or a user nudge), so it's a no-op today — but only that one block is touched, since trimming every assistant turn would silently edit history the model already produced.
- `buildAnthropicBody` — required `max_tokens`; two `cache_control: {type:'ephemeral'}` breakpoints — one on the `system` block (the custom prompt + resume + preferences, the largest constant in the request, and job-independent so it survives across postings) and one on the **last block of the last turn**, the multi-turn pattern. Without the second, every agent-loop iteration re-sent the JD, the previous assistant turn and each `tool_result` at full price: measured at 8,391 full-price tokens on one second turn against 1,516 read. Thinking blocks are skipped when placing it — they take no `cache_control`; `temperature` omitted unless configured (Opus 4.7+ and Sonnet 5 reject a non-default value, and any model rejects one while thinking is on — which Opus 5 is by default, so in practice leaving it unset is the only safe setting there); `output_config.format` for strict JSON; tools mapped to `{name, description, input_schema}`.
- `readAnthropicResponse` — text blocks joined, `tool_use` blocks re-serialised as `tool_calls` (arguments back to a JSON string), plus `stop_reason` and a flattened `stop_details`. It also returns **`reasoning_blocks`**: the turn's `thinking` / `redacted_thinking` blocks verbatim. Those are mandatory to replay — when thinking is on (and **Claude Opus 5 thinks by default**, with no `thinking` field sent) the API rejects a `tool_result` whose assistant turn has lost its thinking blocks, on ordering/signature grounds. So `signature_delta` is accumulated rather than ignored, `redacted_thinking`'s `data` is read off its start event, and both ride the transcript as an opaque `ChatMessage.reasoning_blocks` that only this module produces or consumes — `toAnthropicMessages` emits them at the head of the assistant turn, where Anthropic requires them. A thinking block that arrived **without** a signature (a proxy that strips it) is dropped rather than echoed, since an unsigned block is itself a 400; that reproduces the pre-fix behaviour instead of guaranteeing a failure. The field is `undefined` on every other backend, so `JSON.stringify` omits it and nothing extra reaches an OpenAI endpoint.
- Stream folding — `newAnthropicStreamState` / `applyAnthropicStreamEvent` / `finishAnthropicStream`. Needed because a `tool_use` block's arguments arrive as `input_json_delta` fragments that are only valid JSON once concatenated; `finishAnthropicStream` collapses the accumulated blocks into the non-streaming response shape so `readAnthropicResponse` is the only place that interprets a reply. Malformed/truncated tool JSON becomes `{}` rather than dropping the call — the transcript still lines up with its `tool_result`.

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
| `QWEN_MODELS` | `as const` tuple of selectable models: `['qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus']`. `QWEN_MODELS[0]` is the default. |
| `QwenModel` | Type alias for `(typeof QWEN_MODELS)[number]`. Used by `LLMConfig.qwenModel`. |
| `normalizeQwenModel(input?)` | Returns a valid `QwenModel` or `QWEN_MODELS[0]`; guards against invalid/empty persisted or imported config values. |
| `getQwenToken()` | Retrieves the active JWT — first from the `token` cookie on `chat.qwen.ai`, falling back to `chrome.scripting.executeScript` against an open `chat.qwen.ai` tab to pull it from localStorage. |
| `updateQwenCookies()` | Generates fresh `ssxmod_itna` / `ssxmod_itna2` security cookies via [`cookie-generator.ts`](#qwencookie-generatorts) and writes them to the cookie jar. Called before every completions request. |
| `createQwenSession(token, model?)` | `POST /api/v2/chats/new` — opens a new chat on the user's account and returns the `chat_id`. Sends `models: [model]`. |
| `sendQwenChat(messages, signal?, model?)` | Non-streaming wrapper around `sendQwenChatStream` that accumulates chunks and resolves to the final string. Forwards `model`. |
| `sendQwenChatStream(messages, onChunk, onDone, onError, signal?, model?)` | Streams SSE from `POST /api/v2/chat/completions`. Refreshes security cookies, retrieves the token, opens a session, then decodes deltas in real time. `model` (normalized via `normalizeQwenModel`) flows into the session, the message payload's `models`, and the completions `model` field. A 10-second keep-alive ping (`QWEN_PING` to background) keeps the service worker alive during long responses. |

**Anti-bot / overload retry:** Qwen's WAF can answer the completions request with an Alibaba "tmd"/x5sec **punish** body instead of an SSE stream — e.g. `{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],"data":{"url":".../_____tmd_____/punish?x5secdata=...&action=captcha"}}` ("we're overloaded, please retry later"). It can arrive as a non-2xx body **or** as HTTP 200 with that JSON (no `data:` deltas — previously this silently resolved to `''`). `isQwenAntiBotChallenge()` sniffs the markers (`RGV587_ERROR` / `FAIL_SYS_USER_VALIDATE` / `_____tmd_____` / `x5secdata`) in the error text, the streamed `{error}` event, or the buffered response head. On a hit, `sendQwenChatStream` waits **30s** and **retries the SAME `chat_id`** — session creation (`/chats/new`), token lookup, and one cookie refresh happen once up front; only the completions fetch is re-sent (with fresh `ssxmod_itna` cookies each retry). **Up to 3 retries** (4 total tries); the `abortableDelay` honors the signal so cancel/CANCEL_ANALYSIS during the back-off rejects immediately. Exhausting the retries throws "Qwen is overloaded or rate-limiting requests…". The retry loop lives *inside* the stream (not in `sendQwenChat`) precisely so it doesn't re-`/new`. This path bypasses `llm-client`'s 429/5xx retry entirely.

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

Agent loop driver. Replaces the old `runWithValidation` for evaluator output. Pure TS — runs in whichever realm called it; for analysis and resume that's the offscreen document (or the sidepanel on `chrome-prompt`).

**Cloud and Anthropic both genuinely participate in the tool-calling loop** — Anthropic's `tool_use` blocks are re-serialised as OpenAI-shaped `tool_calls`, so the loop is backend-agnostic. Chrome short-circuits here because `resolveOutput` routes it to the inline-prompt path (Gemini Nano has no native tool API). Qwen short-circuits because it is itself an agent — forwarding our tool schemas would be meaningless.

| Export | Purpose |
|---|---|
| `runAgent(config, messages, options)` | Drives an OpenAI-style tool-calling loop: model → tool calls → append results → loop. Caps at `MAX_AGENT_ITERATIONS = 10`; research tools are stripped after `MAX_TOOL_ROUNDS = 5`. When `options.verdictName` is set, the matching `provide_verdict` call is intercepted as the in-house structured-output channel: its arguments become the returned JSON content, siblings are dropped from history, and the loop ends. If the model emits plain text instead of calling it, a nudge message is appended and the loop continues. |
| `runAgentWithValidation<T>(config, messages, options & { validate })` | Wraps `runAgent` with a JSON-extract + validate step. On validation failure, appends the errors as a `role: 'tool'` message (referencing the `provide_verdict` call's `tool_call_id` when the structured-output channel is in play, otherwise a plain-text user turn) and re-runs the agent so the correction flows through the same channel. |
| `executeTool(call, signal?)` | The default `ToolExecutor`: parses the call's arguments, switches on the tool name, returns the result as a string. |
| `createCachedExecutor(base?)` | Wraps a `ToolExecutor` with a per-run cache so the same search/page isn't fetched twice within one analysis. |

The executor is supplied through `options.executeTool` (`(call, signal?) => Promise<string>`) rather than a handlers map. Adding a new tool is: (1) add the schema in `tools/definitions.ts`, (2) add a branch in `executeTool`. All 5 evaluators + summary share the same `ALL_TOOLS` set and one cached executor built per analysis.

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

Orchestration glue. Runs wherever it is called from — `runAnalysis` / `runResume` in the offscreen document (or the sidepanel on `chrome-prompt`), `runChat` in the service worker; see the realm table under [`llm-client.ts`](#llm-clientts). The Chrome backend flows through `chrome-ai-client` instead of calling `LanguageModel` directly.

| Export | Returns | Used by |
|---|---|---|
| `runAnalysis(job, signal, onProgress?)` | `{ ok: true, report } \| { ok: false, error }` | `background.ts` |
| `runResume(job, analysisContext?, previousResume?, previousSummary?, comment?, qnaHistory?, signal?)` | `{ ok: true, markdown, summary } \| { ok: false, error }` | `background.ts` |
| `runChat(question, history, jobMarkdown, analysisContext)` | `{ ok: true, answer } \| { ok: false, error }` | `background.ts` |
| `buildChatSystemPrompt(profile, jobMarkdown, analysisContext)` | `string` | `ReportChat` (used by `useChromeChatSession` on the Chrome path) |

Each loads `profile`, `llmConfig`, and `customPrompt` from `chrome.storage.local` internally. Cloud and Anthropic backends additionally validate `base_url` + `model`; Chrome backend skips that check.

**Anthropic session id.** On the `'anthropic'` backend, `loadConfigAndProfile` stamps a runtime-only `config.session_id` (never written back to storage) that `anthropicRequest` sends as `x-claude-code-session-id`. It rides on the config because that's the one object already threaded through the runner, every evaluator and the agent loop.

`sessionIdFor(seed)` is a SHA-256 of the seed formatted as a UUID (v8 — the "custom" version, with the RFC 4122 variant bits set), so the same seed always yields the same id.

**The seed is the active LLM profile, not the job** — that scope is the whole point. Cache entries are partitioned by session, and each evaluator's system block is **job-independent**: the JD lives in a *user* turn, so `job_fit` sends byte-identical tools + system for every posting a profile analyses. Measured on a real capture that block is ~21k tokens. Under a per-job seed each posting got its own partition, so the block was rewritten every run and read zero times; one partition per profile lets the next posting analysed inside the TTL read it instead. Analysing five postings drops that slice from ~235k tokens to ~63k. `summary` is the one evaluator that puts the JD in its system block, so it stays job-specific and can't share.

A stable id is also what stops the proxy deriving one from the first user message: that message is our whole JD, so a derived id changed on every call and even a repeated system block was read zero times. `api.anthropic.com` ignores the header — this is a proxy-side partition.

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

Greenhouse DOM parser (`job-boards.greenhouse.io`; the legacy `boards.greenhouse.io` host 301-redirects there). Runs inside the content script.

**Key selectors:** `h1.section-header` (title, falls back to `meta[og:title]`), `.job__location` (location), `.job__description` (description via `innerText`). Company is parsed from `document.title` (`"Job Application for <title> at <Company>"`, using the last ` at `), falling back to the capitalized org slug in the URL path.

`extractGreenhouseJobId(url)` returns `gh:<id>` from `.../<org>/jobs/<id>`; `isGreenhouseJobUrl(url)` gates dispatch.

## `extractor/linkedin.ts`

LinkedIn DOM parser. Runs inside the content script.

**Two layouts** (LinkedIn serves the job detail differently by route):
- `/jobs/view/<id>` → `[data-testid="lazy-column"]`; company/title/location are the first three `<p>` tags (`extractFromLazyColumn`).
- `/jobs/search/` & `/jobs/collections/` panes (`?currentJobId=<id>`) → `.job-details-jobs-unified-top-card__*` for title/company/primary-description (`extractFromUnifiedTopCard`).

`JOB_CONTENT_SELECTOR` (either container) gates `isJobPostingPage` / `waitForJobPostingPage`; `extractJob` branches on whichever container is present, with `document.title` fallbacks for title/company.

**Description (`extractDescription`):** prefers `#job-details` / `.jobs-description__content` (the search/collections panes render the full body there), falling back to walking from the "About the job" `h2` to its first substantial sibling (the `/jobs/view/` structure).

---

## `extractor/markdown.ts`

`jobToMarkdown(job: ExtractedJob): string`

Converts an `ExtractedJob` to a Markdown document for LLM prompts. Includes all fields: URL, title, company, location, salary, employment type, experience level, description, requirements, benefits.

---

## `utils.ts`

`cn(...inputs)` — Combines `clsx` and `tailwind-merge` for conditional class composition.
