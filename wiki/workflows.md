# Workflows

## Job Analysis

```
1. User navigates to a LinkedIn job posting
2. Clicks "Extract & Analyze" (or "Extract") in the side panel
3. useAnalysis.extract() → REQUEST_EXTRACTION → background.ts
4. background queries active tab URL
5. If content script not loaded → scripting.executeScript injects it
6. background sends EXTRACT_JD → content.ts
7. content.ts runs extractJob() (DOM parsing)
8. Returns JD_EXTRACTED { job: ExtractedJob } → background → sidepanel
9. Sidepanel renders JobSummaryCard, awaits user confirmation
10. User clicks "Analyze" → ANALYZE_JD → background.ts relays as OFFSCREEN_ANALYZE_JD → offscreen
    Deduplication lives in src/hooks/useTabSessions.ts: analyze() checks analysisPromisesRef
    (Map keyed by jobId) and returns the existing in-flight promise when another tab
    triggers analysis for the same job_id. The reused promise represents only the analyze()
    dispatch (fire-and-forget message send), not the full remote completion. background.ts
    does NOT deduplicate by jobId — it only manages abort/replace by tabId.
11. offscreen calls runAllEvaluators(job, profile, config, customPrompt, onProgress)
12. 5 LLM evaluators run in parallel (Promise.all)
13. Each evaluator calls onProgress() → offscreen broadcasts ANALYSIS_PROGRESS → sidepanel
14. Sidepanel updates EvaluatorCard status in real-time
15. All evaluators settle → aggregate() computes score, verdict, risks, tips
16. offscreen broadcasts ANALYSIS_COMPLETE with report/error
17. background persists AggregatedReport to IndexedDB (read-modify-write on existing session)
18. sidepanel's ANALYSIS_COMPLETE listener updates state and persists
```

---

## Resume Generation

```
1. User clicks "Generate Resume" (after analysis)
2. useResumeGenerator.generate(job, analysisContext) → GENERATE_RESUME → background
   (fire-and-forget for remote backend; result via RESUME_COMPLETE broadcast)
3. background calls resume evaluator with:
   - Job description (Markdown)
   - Original resume + projects
   - AggregatedReport context (verdict, strengths, gaps)
4. offscreen broadcasts RESUME_COMPLETE; background persists to IDB, sidepanel updates state
5. ResumeView renders Preview tab (marked → HTML) and Edit tab (raw Markdown)
6. User optionally edits or types feedback → submits (Cmd+Enter)
7. useResumeGenerator.regenerate(job, comment) → GENERATE_RESUME with:
   - Previous markdown version
   - Cumulative summary (changelog)
   - User feedback comment
8. New version returned and rendered; summary grows cumulatively
9. User downloads as .md or .pdf
```

---

## Resume / Analysis Cancellation

```
1. User clicks "Cancel" on an in-progress resume generation or analysis
2. useTabSessions calls localResumeControllersRef.abort(tabId) (Chrome backend)
   or localAnalysisControllersRef.abort(tabId)
3. CANCEL_RESUME (or CANCEL_ANALYSIS) message sent to background worker
4. background.ts looks up the tabId in resumeControllers (or analysisControllers)
5. Calls controller.abort(new DOMException('User stopped resume generation', 'AbortError'))
6. Controller deleted from Map
7. LLM handler (runResume / runAnalysis) receives AbortError → returns error result
8. UI state updated to 'idle'; feedback footer always displayed (no string-matching filtering)
```

---

## Cross-Tab Synchronization

```
1. Tab A and Tab B are both viewing the same job_id
2. Tab A starts resume generation (or analysis)
3. Tab A is closed (or user cancels)
4. chrome.tabs.onRemoved fires in background → aborts controller with "Tab was closed"
5. onTabRemoved callbacks fire in useTabSessions for sibling tabs
6. Sibling tabs viewing the same job_id reset to idle state
7. No frozen or stuck loading states in remaining tabs
```

---

## Settings & Profile

```
1. User opens Settings → SettingsForm
2. Configures: base_url, model, api_key, custom_headers (JSON)
3. Optionally adds custom system prompt (prepended to all evaluator prompts)
4. useProfile.updateLLMConfig() → saveLLMConfig() → chrome.storage.local

5. User opens Profile → ProfileForm
6. Enters: resume, salary_expectation, projects
7. Configures preferences: remote, locations, company size, industries, deal breakers, YOE
8. useProfile.updateProfile() → saveProfile() → chrome.storage.local
```

---

## History

```
1. User opens History → HistoryList
2. useHistory.refresh() → listSessions() from IndexedDB, filtered to sessions with report, sorted by updatedAt desc
3. Each entry shows: title, company, compact timestamp (14d/3h/just now), VerdictBadge
4. Clicking entry → HistoryDetail (read-only: JobSummaryCard + AnalysisReport, no chat)
5. Trash icon (with confirm) → deleteSession(job_id) → optimistic state update (no scroll reset)
6. "Clear All" (with confirm) → clearSessions() → refresh()
7. ExternalLink in detail header → openOrFocusTab(url, job_id) — focuses existing tab or opens new
8. RotateCcw in detail header → restoreRecord() → saves fresh PersistedSession (clears Q&A/resume)
   → invalidateHydration(jobId) in useTabSessions → panel re-hydrates from new session
   → navigates to LinkedIn URL → setGlobalView(null) closes history
```

---

## Report Chat (Q&A)

```
1. User types a question in ReportChat and submits
2. targetTabId captured at submit time; chatNonce bumped via onBumpChatNonce
3. onSetChatLoading(tabId, true, nonce) fires first → then onAppend([userTurn], tabId, nonce)
   → both in same render batch; no frame where spinner is absent but last turn is user
4. CHAT_REQUEST → background → LLM → CHAT_RESPONSE
5. onAppend([assistantTurn], tabId, nonce) — no-op if nonce is stale
6. onSetChatLoading(tabId, false, nonce) — no-op if nonce is stale
7. If last turn is a dangling user question → Retry button appears
8. Retry bumps nonce again, shows local retrying state immediately, re-sends request
9. Tab switch: response routes to captured targetTabId, not active tab at response time
```

---

## Custom Prompt Prepending

If the user has configured a custom system prompt, it will be the first system prompt for  **all llm calls**.

---

## Error Handling

- **Evaluator failure (fail-fast + resume):** the pipeline stops along a failed
  branch instead of degrading. A failed evaluator's dependents are marked
  `blocked` (shown as "Skipped"), and the partial report is **not** saved to
  history. `AnalysisReport` shows a **Continue** banner; clicking it
  (`continueAnalysis`) re-runs the failed evaluators + their dependents, reusing
  the successful results via `priorResults`. See [evaluators.md](evaluators.md)
  for the dependency graph.
- **Duplicate analysis (same job_id):** analyze() returns the existing in-flight
  promise. This prevents redundant API calls when the user clicks "Analyze" on
  multiple tabs viewing the same job.
- **LLM validation failure:** `runAgentWithValidation` retries once with the validation error in context.
- **HTTP errors:** Retried on 429/5xx with 1s → 3s delays.
- **Extraction failure:** Content script returns `JD_EXTRACTION_FAILED`; sidepanel shows error state.
- **Content script not injected:** Background catches scripting errors and returns extraction failure.
