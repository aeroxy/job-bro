use bun for package management

be concise

read and update wiki below when needed

---

## Wiki

Enriched project context:

- [overview.md](wiki/overview.md) — Project purpose, tech stack, extension metadata, core constraints
- [architecture.md](wiki/architecture.md) — Directory structure, process model, IPC message flow, storage layout
- [evaluators.md](wiki/evaluators.md) — All 5 AI evaluators, aggregator, scoring weights, verdict logic, resume generator
- [types.md](wiki/types.md) — Full TypeScript type reference (ExtractedJob, UserProfile, AggregatedReport, all evaluator results)
- [components.md](wiki/components.md) — React hooks (useAnalysis, useProfile, useResumeGenerator, useHistory) and UI components
- [lib.md](wiki/lib.md) — LLM client, storage wrappers, IndexedDB, download utilities, LinkedIn extractor
- [workflows.md](wiki/workflows.md) — Step-by-step flows for analysis, resume generation, settings, history, error handling
