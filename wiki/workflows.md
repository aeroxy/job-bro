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
10. User clicks "Analyze" → ANALYZE_JD → background.ts (deduplication: if same
    job_id is already in-flight across tabs, the existing promise is reused)
11. background calls runAllEvaluators(job, profile, config, customPrompt, onProgress)
12. 5 LLM evaluators run in parallel (Promise.all)
13. Each evaluator calls onProgress() → background sends ANALYSIS_PROGRESS → sidepanel
14. Sidepanel updates EvaluatorCard status in real-time
15. All evaluators settle → aggregate() computes score, verdict, risks, tips
16. AggregatedReport saved to IndexedDB
17. background sends ANALYSIS_RESULT → sidepanel renders AnalysisReport
```

---

## Resume Generation

```
1. User clicks "Generate Resume" (after analysis)
2. useResumeGenerator.generate(job, analysisContext) → GENERATE_RESUME → background
3. background calls resume evaluator with:
   - Job description (Markdown)
   - Original resume + projects
   - AggregatedReport context (verdict, strengths, gaps)
4. Returns RESUME_RESULT { markdown, summary } → sidepanel
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

If the user has configured a custom system prompt:

```
buildMessages(customPrompt, internalPrompt, userContent)
  → system: `${customPrompt}\n\n${internalPrompt}`
  → user: userContent
```

This applies to **all 5 evaluators** and the resume generator.

---

## Error Handling

- **Duplicate analysis (same job_id):** analyze() returns the existing in-flight
  promise. This prevents redundant API calls when the user clicks "Analyze" on
  multiple tabs viewing the same job.
- **LLM validation failure:** `runWithValidation` retries once with the validation error in context.
- **HTTP errors:** Retried on 429/5xx with 1s → 3s delays.
- **Extraction failure:** Content script returns `JD_EXTRACTION_FAILED`; sidepanel shows error state.
- **Content script not injected:** Background catches scripting errors and returns extraction failure.
