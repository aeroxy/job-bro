# Project Overview

**Job Bro** is an AI-powered Chrome extension that analyzes job postings (LinkedIn and Greenhouse) and helps job seekers decide which positions to pursue.

## What It Does

1. **Extracts** job descriptions directly from LinkedIn and Greenhouse job posting pages
2. **Analyzes** them across 5 dimensions using an OpenAI-compatible LLM
3. **Returns a verdict** — Strong Apply, Maybe, or Skip — with a scored report
4. **Generates tailored resumes** for a specific job, with iterative feedback
5. **Persists history** of all past analyses in IndexedDB

## Tech Stack

| Layer | Technology |
|---|---|
| Extension Framework | WXT (Web Extension Toolkit) |
| Language | TypeScript |
| UI | React 19 + Radix UI + Shadcn |
| Styling | Tailwind CSS 4 |
| Icons | Lucide React |
| Storage | `chrome.storage.local` + IndexedDB (idb) |
| LLM Integration | OpenAI-compatible HTTP · Chrome built-in AI (Gemini Nano) · Qwen Chat (delegated agent via user's `chat.qwen.ai` session) |
| Markdown | `marked` |
| Build | Vite (via WXT) |
| Package Manager | Bun |

## Extension Metadata

- **Manifest:** V3
- **Permissions:** `sidePanel`, `storage`, `activeTab`, `tabs`, `scripting`, `offscreen`, `cookies`, `declarativeNetRequest`
- **Host Permissions:** `*://*/*` (Cloud LLM endpoint + `chat.qwen.ai` API)
- **UI Entry:** Side panel (`sidepanel/index.html`)
- **Version:** see `package.json` (source of truth — do not mirror here)

## Core Constraints

- All LLM API calls are made from the **background service worker** — never from the content script or sidepanel directly.
- Communication between sidepanel ↔ background is **message-based** via `chrome.runtime.sendMessage`.
- User profile, LLM config, and custom prompt are stored in `chrome.storage.local`.
- Past analyses are stored in **IndexedDB** for large payload support.
