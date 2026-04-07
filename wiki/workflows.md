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
10. User clicks "Analyze" → ANALYZE_JD → background.ts
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
2. useHistory.refresh() → listAnalyses() from IndexedDB (sorted by createdAt desc)
3. Each entry shows: title, company, timestamp, VerdictBadge
4. Clicking entry → HistoryDetail → getAnalysis(id) → renders JobSummaryCard + AnalysisReport
5. Trash icon → deleteAnalysis(id) → refresh()
6. "Clear All" → clearAnalyses() → refresh()
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

- **Evaluator failure:** Wrapped in `runWithTracking`. If an evaluator throws, its `EvaluatorStatus` is set to `{ status: "rejected", reason: ... }`. Aggregator skips it and adjusts weighted total accordingly.
- **LLM validation failure:** `runWithValidation` retries once with the validation error in context.
- **HTTP errors:** Retried on 429/5xx with 1s → 3s delays.
- **Extraction failure:** Content script returns `JD_EXTRACTION_FAILED`; sidepanel shows error state.
- **Content script not injected:** Background catches scripting errors and returns extraction failure.
