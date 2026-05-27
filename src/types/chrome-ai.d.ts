// Ambient typings for Chrome's built-in Prompt API (Gemini Nano).
// Reference: https://developer.chrome.com/docs/ai/prompt-api

export {}

declare global {
  type ChromeAiAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available'

  interface ChromeAiPromptMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
  }

  interface ChromeAiDownloadProgressEvent extends Event {
    loaded: number  // 0..1 fraction in current Chrome (per spec)
  }

  interface ChromeAiCreateMonitor {
    addEventListener(type: 'downloadprogress', listener: (e: ChromeAiDownloadProgressEvent) => void): void
  }

  interface ChromeAiExpectedIO {
    type: 'text' | 'image' | 'audio'
    languages?: string[]  // BCP-47 codes; supported set is small (e.g. en, es, ja)
  }

  interface ChromeAiCreateOptions {
    initialPrompts?: ChromeAiPromptMessage[]
    temperature?: number
    topK?: number
    monitor?: (m: ChromeAiCreateMonitor) => void
    signal?: AbortSignal
    expectedInputs?: ChromeAiExpectedIO[]
    expectedOutputs?: ChromeAiExpectedIO[]
  }

  interface ChromeAiPromptOptions {
    signal?: AbortSignal
    responseConstraint?: object  // JSON Schema
  }

  interface ChromeAiSession {
    prompt(input: string | ChromeAiPromptMessage[], options?: ChromeAiPromptOptions): Promise<string>
    promptStreaming(input: string | ChromeAiPromptMessage[], options?: ChromeAiPromptOptions): ReadableStream<string>
    destroy(): void
    clone(options?: { signal?: AbortSignal }): Promise<ChromeAiSession>
  }

  interface ChromeAiLanguageModel {
    availability(): Promise<ChromeAiAvailability>
    create(options?: ChromeAiCreateOptions): Promise<ChromeAiSession>
  }

  // Chrome exposes LanguageModel as a global on Window in supported builds.
  // eslint-disable-next-line no-var
  var LanguageModel: ChromeAiLanguageModel | undefined

  interface Window {
    LanguageModel?: ChromeAiLanguageModel
  }

  interface ChromeAiNamespace {
    languageModel?: ChromeAiLanguageModel
  }

  // eslint-disable-next-line no-var
  var ai: ChromeAiNamespace | undefined
}
