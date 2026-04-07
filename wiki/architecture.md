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

```
User → LinkedIn Job Page
         │
         ▼ (content script — DOM parsing)
    ExtractedJob
         │
         ▼ (chrome.runtime.sendMessage)
    Background Service Worker
         │
         ▼ (Promise.all)
    5 Parallel LLM Evaluators
         │ (ANALYSIS_PROGRESS messages)
         ▼
    Sidepanel — live progress updates
         │
         ▼ (aggregator)
    AggregatedReport → saved to IndexedDB
         │
         ▼
    User views report / generates resume / browses history
```

## IPC Message Flow

All communication uses `chrome.runtime.sendMessage`. Message types are defined in `src/types/messages.ts`:

| Message | Direction | Description |
|---|---|---|
| `REQUEST_EXTRACTION` | sidepanel → background | User clicked extract |
| `EXTRACT_JD` | background → content | Trigger DOM extraction |
| `JD_EXTRACTED` | content → background | Returns `ExtractedJob` |
| `JD_EXTRACTION_FAILED` | content → background | Extraction error |
| `ANALYZE_JD` | sidepanel → background | Start evaluators |
| `ANALYSIS_PROGRESS` | background → sidepanel | Per-evaluator status update |
| `ANALYSIS_RESULT` | background → sidepanel | Final `AggregatedReport` |
| `ANALYSIS_ERROR` | background → sidepanel | Evaluator failure |
| `GENERATE_RESUME` | sidepanel → background | Trigger resume generation |
| `RESUME_RESULT` | background → sidepanel | Markdown resume + changelog |
| `RESUME_ERROR` | background → sidepanel | Resume generation failure |

## Storage Layout

| Store | Key/Table | Contents |
|---|---|---|
| `chrome.storage.local` | `profile` | `UserProfile` |
| `chrome.storage.local` | `llmConfig` | `LLMConfig` |
| `chrome.storage.local` | `customPrompt` | System prompt prefix string |
| IndexedDB `job-bro` | `analyses` | `AnalysisRecord[]` (indexed by `createdAt`, `company`) |

## Content Script Injection

The content script (`content.ts`) is declared in `wxt.config.ts` to match `*://www.linkedin.com/jobs/*`. If it hasn't loaded when the user clicks extract, the background worker injects it programmatically via `chrome.scripting.executeScript`.
