# Libraries & Utilities

## `llm-client.ts`

OpenAI-compatible fetch-based LLM client.

### `chatCompletion(config, messages, options)`

Makes a POST to `config.base_url + /chat/completions`.

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
