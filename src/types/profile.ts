export interface UserProfile {
  resume: string
  salary_expectation: string
  projects: string
  preferences: JobPreferences
}

export interface JobPreferences {
  remote_preference: 'remote' | 'hybrid' | 'onsite' | 'no_preference'
  preferred_locations: string
  company_size_preference: 'startup' | 'mid' | 'large' | 'no_preference'
  industries_of_interest: string
  deal_breakers: string
  years_of_experience: number
}

export type LLMBackend = 'openai' | 'chrome-prompt'

export interface LLMConfig {
  backend?: LLMBackend    // default: 'openai' (back-compat for existing configs)
  base_url: string        // openai backend only
  model: string           // openai backend only
  api_key?: string
  custom_headers?: string // JSON string of key-value pairs, e.g. '{"X-API-Key": "abc"}'
  stream_mode?: boolean
  tools_enabled?: boolean // cloud backend only. Default true. Some local LLM
                          // servers (small models, llama.cpp, older Ollama)
                          // don't support the function-calling protocol and
                          // will error or hallucinate tool calls; disable
                          // for those. The agent loop still runs — it just
                          // makes a single call with no tools.
  structured_output?: boolean // cloud backend only. Default false. When true,
                              // evaluators pass a JSON Schema via
                              // response_format.json_schema so the model
                              // can't drift shape and parseJSON retries drop
                              // to near zero. Requires a provider that
                              // supports the OpenAI json_schema response
                              // format (OpenAI, Groq, Together, Fireworks,
                              // vLLM, etc.). Ignored for chrome-prompt.
  temperature?: number    // sampling temperature. Left unset by default so the
                          // provider applies its own default (some reasoning
                          // models reject or ignore an explicit temperature).
  max_tokens?: number     // max completion tokens (default 8192). Reasoning
                          // models count reasoning_content against this budget,
                          // so a low value can be fully consumed by reasoning,
                          // leaving empty content. Raise it for such models.
  timeout?: number        // non-stream request timeout in seconds (default 30)
  stream_timeout?: number // per-chunk inactivity timeout in seconds (default 60)
  concurrency?: number    // max concurrent calls for this provider (default 2)
}

export interface LLMProfile {
  id: string
  name: string
  config: LLMConfig
  customPrompt: string
}

export const DEFAULT_PREFERENCES: JobPreferences = {
  remote_preference: 'no_preference',
  preferred_locations: '',
  company_size_preference: 'no_preference',
  industries_of_interest: '',
  deal_breakers: '',
  years_of_experience: 0,
}
