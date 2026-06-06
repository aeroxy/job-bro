import type { LLMBackend, LLMConfig, LLMProfile, UserProfile } from '@/types/profile'

const KEYS = {
  profile: 'jobBroProfile',
  llmConfig: 'jobBroLLMConfig',
  llmProfiles: 'jobBroLLMProfiles',
  activeProfileId: 'jobBroActiveProfileId',
  customPrompt: 'jobBroCustomPrompt',
  customPromptChrome: 'jobBroCustomPromptChrome',
} as const

export async function getProfile(): Promise<UserProfile | null> {
  const result = await chrome.storage.local.get(KEYS.profile)
  return result[KEYS.profile] ?? null
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  await chrome.storage.local.set({ [KEYS.profile]: profile })
}

// --- Cloud LLM profiles ---

export async function getLLMProfiles(): Promise<LLMProfile[]> {
  const result = await chrome.storage.local.get(KEYS.llmProfiles)
  return result[KEYS.llmProfiles] ?? []
}

export async function saveLLMProfiles(profiles: LLMProfile[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.llmProfiles]: profiles })
}

export async function getActiveProfileId(): Promise<string | null> {
  const result = await chrome.storage.local.get(KEYS.activeProfileId)
  return result[KEYS.activeProfileId] ?? null
}

export async function setActiveProfileId(id: string | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.activeProfileId]: id })
}

// Migrate legacy single LLMConfig + customPrompt into a named profile.
// Returns the profiles array (migrated or existing).
export async function migrateLLMProfiles(): Promise<LLMProfile[]> {
  const profiles = await getLLMProfiles()
  if (profiles.length > 0) return profiles

  const legacyConfig = await getLLMConfigRaw()
  if (!legacyConfig) return []

  const legacyPrompt = await getCustomPrompt('openai')

  const migrated: LLMProfile = {
    id: crypto.randomUUID(),
    name: 'Default',
    config: legacyConfig,
    customPrompt: legacyPrompt,
  }

  await Promise.all([
    saveLLMProfiles([migrated]),
    setActiveProfileId(migrated.id),
  ])

  return [migrated]
}

// Resolve the active LLMConfig from profiles. Falls back to legacy key.
export async function getLLMConfig(): Promise<LLMConfig | null> {
  const profiles = await getLLMProfiles()
  if (profiles.length > 0) {
    const activeId = await getActiveProfileId()
    const active = activeId ? profiles.find((p) => p.id === activeId) : profiles[0]
    return (active ?? profiles[0]).config
  }

  const migrated = await migrateLLMProfiles()
  if (migrated.length > 0) return migrated[0].config

  return getLLMConfigRaw()
}

// Resolve the active cloud custom prompt from profiles. Falls back to legacy key.
export async function getCustomPrompt(backend?: LLMBackend): Promise<string> {
  if (backend === 'chrome-prompt') {
    const key = KEYS.customPromptChrome
    const result = await chrome.storage.local.get(key)
    return result[key] ?? ''
  }

  const profiles = await getLLMProfiles()
  if (profiles.length > 0) {
    const activeId = await getActiveProfileId()
    const active = activeId ? profiles.find((p) => p.id === activeId) : profiles[0]
    return (active ?? profiles[0]).customPrompt ?? ''
  }

  const key = KEYS.customPrompt
  const result = await chrome.storage.local.get(key)
  return result[key] ?? ''
}

export async function saveCustomPrompt(prompt: string, backend?: LLMBackend): Promise<void> {
  if (backend === 'chrome-prompt') {
    await chrome.storage.local.set({ [KEYS.customPromptChrome]: prompt })
    return
  }

  const profiles = await getLLMProfiles()
  if (profiles.length > 0) {
    const activeId = await getActiveProfileId()
    const idx = activeId ? profiles.findIndex((p) => p.id === activeId) : 0
    const target = idx >= 0 ? idx : 0
    profiles[target].customPrompt = prompt
    await saveLLMProfiles(profiles)
  }

  await chrome.storage.local.set({ [KEYS.customPrompt]: prompt })
}

// Raw legacy access — used by migration only.
async function getLLMConfigRaw(): Promise<LLMConfig | null> {
  const result = await chrome.storage.local.get(KEYS.llmConfig)
  return result[KEYS.llmConfig] ?? null
}

// Keep for backwards compat — writes to legacy key too so old code paths
// that haven't migrated yet still work.
export async function saveLLMConfig(config: LLMConfig): Promise<void> {
  await chrome.storage.local.set({ [KEYS.llmConfig]: config })
}
