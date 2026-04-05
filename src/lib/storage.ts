import type { LLMConfig, UserProfile } from '@/types/profile'

const KEYS = {
  profile: 'jobBroProfile',
  llmConfig: 'jobBroLLMConfig',
  customPrompt: 'jobBroCustomPrompt',
} as const

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

export async function getCustomPrompt(): Promise<string> {
  const result = await chrome.storage.local.get(KEYS.customPrompt)
  return result[KEYS.customPrompt] ?? ''
}

export async function saveCustomPrompt(prompt: string): Promise<void> {
  await chrome.storage.local.set({ [KEYS.customPrompt]: prompt })
}
