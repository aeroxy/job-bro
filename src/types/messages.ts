import type { AggregatedReport } from './evaluation'
import type { ExtractedJob } from './job'

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
  payload: { job: ExtractedJob }
}

// Background -> Sidebar: analysis complete
export type AnalysisResultMessage = {
  type: 'ANALYSIS_RESULT'
  payload: AggregatedReport
}

// Background -> Sidebar: per-evaluator progress update
export type AnalysisProgressMessage = {
  type: 'ANALYSIS_PROGRESS'
  payload: {
    tabId: number
    evaluator: string
    status: 'running' | 'completed' | 'error'
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
  payload: {
    job: ExtractedJob
    analysisContext?: string  // formatted summary of the AggregatedReport
    previousResume?: string
    previousSummary?: string
    comment?: string
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

export type Message =
  | RequestExtractionMessage
  | ExtractJDMessage
  | JDExtractedMessage
  | JDExtractionFailedMessage
  | AnalyzeJDMessage
  | CancelAnalysisMessage
  | AnalysisResultMessage
  | AnalysisProgressMessage
  | AnalysisErrorMessage
  | GenerateResumeMessage
  | ResumeResultMessage
  | ResumeErrorMessage
