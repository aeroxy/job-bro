# Architecture

## Directory Structure

```
job-bro/
├── src/
│   ├── entrypoints/             # Chrome extension entry points
│   │   ├── background.ts        # Background service worker (LLM routing, offscreen mgmt, FIFO gate)
│   │   ├── content.ts           # Content script (LinkedIn DOM parsing)
│   │   ├── offscreen/           # Hidden document: HTML→markdown parser + Chrome AI host
│   │   │   └── main.ts          # DOMParser + Turndown, LanguageModel session store + FIFO
│   │   ├── offscreen.html       # HTML shell for the offscreen document
│   │   └── sidepanel/
│   │       ├── App.tsx          # Main app component
│   │       └── main.tsx         # React DOM render
│   ├── components/              # React UI components
│   │   └── ui/                  # Shadcn base components
│   ├── evaluators/              # AI evaluation logic
│   ├── hooks/                   # React hooks
│   ├── lib/                     # Utility libraries
│   ├── extractor/               # LinkedIn DOM extraction
│   ├── types/                   # TypeScript type definitions
│   └── assets/                  # Tailwind CSS
├── public/assets/               # Extension icons
├── wxt.config.ts                # WXT / Vite config
├── tsconfig.json
└── components.json              # Shadcn config
```

## Process Model

The service worker is the **single LLM orchestrator**. Both backends route through it; the offscreen document hosts the bits that need a window context.

```
User → LinkedIn Job Page
         │
         ▼ (content script — DOM parsing)
    ExtractedJob
         │
         ▼ (chrome.runtime.sendMessage REQUEST_EXTRACTION)
    Background Service Worker
         │
         ▼ (returns ExtractedJob to sidepanel)
    Sidepanel → ANALYZE_JD → Background
     Background runs llm-handlers.runAnalysis (Promise.all)
     5 evaluators → agent loop → tool calls / verdict tool / chat
         │
         ├── backend === 'openai' ──────────────────────
         │     HTTP fetch → cloud LLM
         │     tool calls → service worker fetch
         │                  → PARSE_HTML → offscreen (DOMParser + Turndown)
         │
         └── backend === 'chrome-prompt' ──────────────
               chrome-ai-client → chrome.runtime.sendMessage → offscreen
               offscreen FIFO queue → LanguageModel.create / .prompt (Gemini Nano)
               Download progress broadcast → sidepanel
         │
         ▼ (aggregator)
    AggregatedReport → saved to IndexedDB
         │
         ▼
    User views report / generates resume / browses history
```

The offscreen is the only place with access to `LanguageModel` (Gemini Nano) and the only place that parses HTML for tools. The service worker serializes everything through it:

- **Tools** (`web_search`, `read_page`, `provide_verdict`): service worker fetches the URL with `AbortSignal.timeout(20s)`, then sends the raw HTML to offscreen with `PARSE_HTML`. Background's `onMessage` returns `false` for `PARSE_HTML` so the offscreen's `sendResponse` wins. The `provide_verdict` tool is terminal — when the model calls it, the agent loop ends and its arguments become the parsed evaluator output.
- **Chrome AI**: every call goes through a single FIFO `withChromeAiLock` inside the offscreen. Persistent chat sessions (one per `useChromeChatSession` instance) are stored in a `Map<sessionId, ChromeAiSession>` and addressed by id. The sidepanel/background hold only the id, not the object.

### AbortController Tracking

The background worker maintains two `Map<number, AbortController>` instances:

- `analysisControllers` — keyed by `tabId`, aborts via `CANCEL_ANALYSIS` or tab close
- `resumeControllers` — keyed by `tabId`, aborts via `CANCEL_RESUME` or tab close

When a new request arrives for a tab that already has an in-flight operation, the existing controller is aborted before creating a new one. All `.abort()` calls pass a descriptive `DOMException` (e.g. "Tab was closed", "User stopped analysis") for error traceability. The sidepanel mirrors this with `localAnalysisControllersRef` and `localResumeControllersRef` for Chrome-backend local execution.

## IPC Message Flow

All communication uses `chrome.runtime.sendMessage`. Message types are defined in `src/types/messages.ts`:

| Message | Direction | Description |
|---|---|---|
| `REQUEST_EXTRACTION` | sidepanel → background | User clicked extract |
| `EXTRACT_JD` | background → content | Trigger DOM extraction |
| `JD_EXTRACTED` | content → background | Returns `ExtractedJob` (includes `job_id`) |
| `JD_EXTRACTION_FAILED` | content → background | Extraction error |
| `ANALYZE_JD` | sidepanel → background → offscreen | Start evaluators (fire-and-forget; result via `ANALYSIS_COMPLETE`) |
| `ANALYSIS_PROGRESS` | background → sidepanel | Per-evaluator status update |
| `ANALYSIS_RESULT` | background → sidepanel | Final `AggregatedReport` (best-effort sendResponse) |
| `ANALYSIS_ERROR` | background → sidepanel | Evaluator failure |
| `ANALYSIS_COMPLETE` | offscreen → all | Broadcast on analysis finish; background listener persists to IDB, sidepanel listener updates session state |
| `GENERATE_RESUME` | sidepanel → background | Trigger resume generation (fire-and-forget; result via `RESUME_COMPLETE`) |
| `CANCEL_RESUME` | sidepanel → background | Abort in-progress resume generation for a tab |
| `RESUME_RESULT` | background → sidepanel | Markdown resume + changelog (best-effort sendResponse) |
| `RESUME_ERROR` | background → sidepanel | Resume generation failure |
| `RESUME_COMPLETE` | offscreen → all | Broadcast on resume finish; background listener persists to IDB, sidepanel listener updates session state |
| `CANCEL_ANALYSIS` | sidepanel → background | Abort in-progress analysis for a tab |
| `CHAT_REQUEST` | sidepanel → background | Follow-up Q&A question |
| `CHAT_RESPONSE` | background → sidepanel | Q&A answer |
| `CHAT_ERROR` | background → sidepanel | Q&A failure |
| `PARSE_HTML` | any → offscreen | `{ html }` → `{ markdown, trimmed }` |
| `CHROME_AI_CHAT` | any → offscreen | One-shot completion; returns `{ result: string }` |
| `CHROME_AI_AVAILABILITY` | any → offscreen | Returns `{ result: ChromeAiAvailability }` |
| `CHROME_AI_DOWNLOAD` | any → offscreen | Triggers model download; returns `{ result: void }` |
| `CHROME_AI_SESSION_CREATE` | any → offscreen | Persistent session; returns `{ result: sessionId }` |
| `CHROME_AI_SESSION_PROMPT` | any → offscreen | Session turn; returns `{ result: string }` |
| `CHROME_AI_SESSION_DESTROY` | any → offscreen | Releases session; returns `{ result: null }` |
| `CHROME_AI_DOWNLOAD_PROGRESS` | offscreen → all | `{ loaded: number }` — broadcast during model download |

## Storage Layout

| Store | Key/Table | Contents |
|---|---|---|
| `chrome.storage.local` | `profile` | `UserProfile` |
| `chrome.storage.local` | `llmConfig` | `LLMConfig` |
| `chrome.storage.local` | `customPrompt` | System prompt prefix string |
| IndexedDB `job-bro` v1 | `analyses` | `AnalysisRecord[]` — legacy audit log (unused; history now reads from `sessions`) |
| IndexedDB `job-bro` v2 | `sessions` | `PersistedSession[]` — live state + history source, keyed by LinkedIn `job_id`, indexed by `updatedAt` |

Sessions are hydrated automatically when the active tab matches a LinkedIn `/jobs/view/<id>/` URL. Q&A history, analysis, and resume state all persist across browser restarts.

**Restore flow:** From History, clicking Restore on an `AnalysisRecord` writes a fresh `PersistedSession` to the `sessions` store (overwriting any existing one for that `job_id`), calls `invalidateHydration(jobId)` in `useTabSessions` to clear the hydration guard, then opens/focuses the LinkedIn tab — triggering automatic re-hydration with the restored data.

## Content Script Injection

The content script (`content.ts`) is declared in `wxt.config.ts` to match `*://www.linkedin.com/jobs/*`. If it hasn't loaded when the user clicks extract, the background worker injects it programmatically via `chrome.scripting.executeScript`.

## LLM Execution Context

| Backend | Runs In | Why |
|---------|---------|-----|
| External HTTP | Service worker | Fetch works reliably; no lifecycle issues |
| Chrome AI | Offscreen document | `LanguageModel` API requires a window; service worker / workers don't have one |
| HTML parsing (tools) | Offscreen document | `DOMParser` + Turndown need DOMParser API; service worker can't create one |

Chrome's built-in `LanguageModel` (Gemini Nano) requires a window context.
The MV3 service worker does not expose this API. We host it (and the
HTML→markdown tool pipeline) in a single `offscreen.html` document created
with `chrome.offscreen.Reason.DOM_PARSER`. All Chrome AI work serializes
through one FIFO inside the offscreen — Gemini Nano is one in-process
model, and the offscreen's `onMessage` listeners fire in parallel.

The shared orchestrator (`llm-handlers.ts`) runs in the service worker.
The Chrome backend goes through `chrome-ai-client`, which messages the
offscreen — no per-context code duplication.
