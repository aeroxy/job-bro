import type { LLMBackend, LLMConfig, UserProfile } from '@/types/profile'

const KEYS = {
  profile: 'jobBroProfile',
  llmConfig: 'jobBroLLMConfig',
  // Legacy key, now scoped to the cloud backend. Kept under the original name
  // to preserve existing user data.
  customPrompt: 'jobBroCustomPrompt',
  customPromptChrome: 'jobBroCustomPromptChrome',
} as const

function customPromptKey(backend?: LLMBackend): string {
  return backend === 'chrome-prompt' ? KEYS.customPromptChrome : KEYS.customPrompt
}

export async function getProfile(): Promise<UserProfile | null> {
  const result = await chrome.storage.local.get(KEYS.profile)
  return result[KEYS.profile] ?? null
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  await chrome.storage.local.set({ [KEYS.profile]: profile })
}

export async function getLLMConfig(): Promise<LLMConfig | null> {
  const result = await chrome.storage.local.get(KEYS.llmConfig)
  return result[KEYS.llmConfig] ?? null
}

export async function saveLLMConfig(config: LLMConfig): Promise<void> {
  await chrome.storage.local.set({ [KEYS.llmConfig]: config })
}

export async function getCustomPrompt(backend?: LLMBackend): Promise<string> {
  const key = customPromptKey(backend)
  const result = await chrome.storage.local.get(key)
  return result[key] ?? ''
}

export async function saveCustomPrompt(prompt: string, backend?: LLMBackend): Promise<void> {
  const key = customPromptKey(backend)
  await chrome.storage.local.set({ [key]: prompt })
}
