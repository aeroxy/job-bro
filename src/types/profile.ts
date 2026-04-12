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

export interface LLMConfig {
  base_url: string
  model: string
  api_key?: string
  custom_headers?: string // JSON string of key-value pairs, e.g. '{"X-API-Key": "abc"}'
  stream_mode?: boolean
  timeout?: number        // non-stream request timeout in seconds (default 30)
  stream_timeout?: number // per-chunk inactivity timeout in seconds (default 60)
}

export const DEFAULT_PREFERENCES: JobPreferences = {
  remote_preference: 'no_preference',
  preferred_locations: '',
  company_size_preference: 'no_preference',
  industries_of_interest: '',
  deal_breakers: '',
  years_of_experience: 0,
}
