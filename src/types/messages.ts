import type { AggregatedReport } from './evaluation'
import type { ExtractedJob } from './job'
import type { ChatTurn } from './chat'

// Sidebar -> Background: request JD extraction from a specific tab
export type RequestExtractionMessage = {
  type: 'REQUEST_EXTRACTION'
  tabId: number
}

// Background -> Content Script: extract JD from the page
export type ExtractJDMessage = {
  type: 'EXTRACT_JD'
}

// Content Script -> Background: JD extracted successfully
export type JDExtractedMessage = {
  type: 'JD_EXTRACTED'
  payload: ExtractedJob
}

// Content Script -> Background: extraction failed
export type JDExtractionFailedMessage = {
  type: 'JD_EXTRACTION_FAILED'
  error: string
}

// Sidebar -> Background: analyze the extracted JD
export type AnalyzeJDMessage = {
  type: 'ANALYZE_JD'
  tabId: number
  payload: {
    job: ExtractedJob
    // Resume support: successful evaluator results from a previous (partially
    // failed) run. The runner reuses these and only re-runs the missing ones
    // (the failed evaluators + everything depending on them). Absent on a
    // fresh run. See useTabSessions.continueAnalysis.
    priorResults?: Partial<AggregatedReport['evaluators']>
  }
}

// Background -> Sidebar: analysis complete
export type AnalysisResultMessage = {
  type: 'ANALYSIS_RESULT'
  payload: AggregatedReport
}

// Background -> Sidebar: per-evaluator progress update. Three kinds:
//   - 'status': high-level state transition (running / completed / error)
//   - 'tool': a tool call the evaluator is about to dispatch (live activity feed)
//   - 'result': the evaluator's final result has landed. Streamed in
//     incrementally so each card's body appears as soon as that evaluator
//     finishes — the user no longer waits for the aggregator to bundle all 5
//     +summary into a single report. `result` is the typed result for this
//     evaluator (JobFitResult | SalaryResult | ...); the sidepanel switches
//     on `evaluator` to assign to the right slot.
export type AnalysisProgressMessage = {
  type: 'ANALYSIS_PROGRESS'
  payload: {
    tabId: number
    evaluator: string
    kind?: 'status' | 'tool' | 'result'
    status?: 'running' | 'completed' | 'error' | 'blocked'
    tool?: {
      name: 'web_search' | 'read_page'
      args: Record<string, string>
      // Monotonic per-evaluator counter; lets the UI replace in-flight activity
      // (the latest "Searching X" supersedes earlier "Searching Y" within the
      // same evaluator's display).
      seq: number
    }
    result?: unknown
  }
}

// Background -> Sidebar: analysis error
export type AnalysisErrorMessage = {
  type: 'ANALYSIS_ERROR'
  error: string
}

// Sidebar -> Background: generate a tailored resume
export type GenerateResumeMessage = {
  type: 'GENERATE_RESUME'
  tabId: number
  payload: {
    job: ExtractedJob
    analysisContext?: string  // formatted summary of the AggregatedReport
    previousResume?: string
    previousSummary?: string
    comment?: string
    qnaHistory?: ChatTurn[]
  }
}

// Background -> Sidebar: resume generated successfully
export type ResumeResultMessage = {
  type: 'RESUME_RESULT'
  payload: { markdown: string; summary: string }
}

// Background -> Sidebar: resume generation error
export type ResumeErrorMessage = {
  type: 'RESUME_ERROR'
  error: string
}

export type ExtractionResponse = JDExtractedMessage | JDExtractionFailedMessage
export type ResumeResponse = ResumeResultMessage | ResumeErrorMessage

export type CancelAnalysisMessage = {
  type: 'CANCEL_ANALYSIS'
  tabId: number
}

export type CancelResumeMessage = {
  type: 'CANCEL_RESUME'
  tabId: number
}

// Sidebar -> Background: ask a follow-up question about the analysis
export type ChatRequestMessage = {
  type: 'CHAT_REQUEST'
  payload: {
    question: string
    history: Array<{ role: 'user' | 'assistant'; content: string }>
    jobMarkdown: string
    analysisContext: string
  }
}

// Background -> Sidebar: chat answer
export type ChatResponseMessage = {
  type: 'CHAT_RESPONSE'
  payload: { answer: string }
}

// Background -> Sidebar: chat error
export type ChatErrorMessage = {
  type: 'CHAT_ERROR'
  error: string
}

export type ChatResponse = ChatResponseMessage | ChatErrorMessage

// Background -> all: analysis finished (broadcast, not request/response).
// The background persists the report to IndexedDB before sending this, so
// the sidepanel can recover from storage if the broadcast is missed.
export type AnalysisCompleteMessage = {
  type: 'ANALYSIS_COMPLETE'
  payload: {
    tabId: number
    ok: boolean
    report?: AggregatedReport
    error?: string
  }
}

// Background -> all: resume generation finished (broadcast).
// Same pattern as AnalysisCompleteMessage — persist then broadcast.
// jobId is carried so the background can persist resume completions when the
// sidepanel is closed (or missed the broadcast); without it the background
// has no key into the sessions store.
export type ResumeCompleteMessage = {
  type: 'RESUME_COMPLETE'
  payload: {
    tabId: number
    jobId: string
    ok: boolean
    markdown?: string
    summary?: string
    error?: string
  }
}

export type Message =
  | RequestExtractionMessage
  | ExtractJDMessage
  | JDExtractedMessage
  | JDExtractionFailedMessage
  | AnalyzeJDMessage
  | CancelAnalysisMessage
  | CancelResumeMessage
  | AnalysisResultMessage
  | AnalysisProgressMessage
  | AnalysisErrorMessage
  | AnalysisCompleteMessage
  | GenerateResumeMessage
  | ResumeResultMessage
  | ResumeErrorMessage
  | ResumeCompleteMessage
  | ChatRequestMessage
  | ChatResponseMessage
  | ChatErrorMessage
