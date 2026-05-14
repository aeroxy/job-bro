# Architecture

## Directory Structure

```
job-bro/
├── src/
│   ├── entrypoints/             # Chrome extension entry points
│   │   ├── background.ts        # Background service worker (LLM calls, routing)
│   │   ├── content.ts           # Content script (LinkedIn DOM parsing)
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

The orchestrator (`src/lib/llm-handlers.ts`) is pure TS and runs in **either** the background worker or the sidepanel window — chosen per request by `LLMConfig.backend`.

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
    Sidepanel decides where to run analysis based on config.backend:

  ─── backend === 'openai' ────────────────────────
    Sidepanel → ANALYZE_JD → Background
    Background runs llm-handlers.runAnalysis (Promise.all)
    5 evaluators → HTTP fetch → cloud LLM
    ANALYSIS_PROGRESS messages stream back to sidepanel
    Background → ANALYSIS_RESULT → sidepanel

  ─── backend === 'chrome-prompt' ─────────────────
    Sidepanel calls llm-handlers.runAnalysis directly
    5 evaluators → chatCompletion → chatCompletionChrome
                → LanguageModel.create / .prompt (Gemini Nano)
    Progress callback updates sidepanel state in-process
         │
         ▼ (aggregator)
    AggregatedReport → saved to IndexedDB
         │
         ▼
    User views report / generates resume / browses history
```

Resume generation and chat Q&A use the same backend dispatch (sidepanel-local for Chrome, background message for cloud). Chat additionally uses a stateful Chrome session via `useChromeChatSession` to avoid re-encoding conversation history on each turn.

## IPC Message Flow

All communication uses `chrome.runtime.sendMessage`. Message types are defined in `src/types/messages.ts`:

| Message | Direction | Description |
|---|---|---|
| `REQUEST_EXTRACTION` | sidepanel → background | User clicked extract |
| `EXTRACT_JD` | background → content | Trigger DOM extraction |
| `JD_EXTRACTED` | content → background | Returns `ExtractedJob` (includes `job_id`) |
| `JD_EXTRACTION_FAILED` | content → background | Extraction error |
| `ANALYZE_JD` | sidepanel → background | Start evaluators |
| `ANALYSIS_PROGRESS` | background → sidepanel | Per-evaluator status update |
| `ANALYSIS_RESULT` | background → sidepanel | Final `AggregatedReport` |
| `ANALYSIS_ERROR` | background → sidepanel | Evaluator failure |
| `GENERATE_RESUME` | sidepanel → background | Trigger resume generation (includes `qnaHistory`) |
| `RESUME_RESULT` | background → sidepanel | Markdown resume + changelog |
| `RESUME_ERROR` | background → sidepanel | Resume generation failure |
| `CHAT_REQUEST` | sidepanel → background | Follow-up Q&A question |
| `CHAT_RESPONSE` | background → sidepanel | Q&A answer |
| `CHAT_ERROR` | background → sidepanel | Q&A failure |

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
