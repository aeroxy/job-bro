import type { AggregatedReport } from './evaluation'
import type { ExtractedJob } from './job'

// Sidebar -> Background: request JD extraction from the active tab
export type RequestExtractionMessage = {
  type: 'REQUEST_EXTRACTION'
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
    evaluator: string
    status: 'running' | 'completed' | 'error'
  }
}

// Background -> Sidebar: analysis error
export type AnalysisErrorMessage = {
  type: 'ANALYSIS_ERROR'
  error: string
}

export type ExtractionResponse = JDExtractedMessage | JDExtractionFailedMessage

export type Message =
  | RequestExtractionMessage
  | ExtractJDMessage
  | JDExtractedMessage
  | JDExtractionFailedMessage
  | AnalyzeJDMessage
  | AnalysisResultMessage
  | AnalysisProgressMessage
  | AnalysisErrorMessage
