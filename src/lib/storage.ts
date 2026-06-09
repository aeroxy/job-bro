import type { LLMBackend, LLMConfig, LLMProfile, UserProfile } from '@/types/profile'

const KEYS = {
  profile: 'jobBroProfile',
  llmConfig: 'jobBroLLMConfig',
  llmProfiles: 'jobBroLLMProfiles',
  activeProfileId: 'jobBroActiveProfileId',
  customPrompt: 'jobBroCustomPrompt',
  customPromptChrome: 'jobBroCustomPromptChrome',
} as const

// Storage bridge: chrome.storage.local is unavailable in offscreen documents.
// When running in that context, route reads/writes through the background
// service worker via chrome.runtime.sendMessage.
const hasStorage = typeof chrome !== 'undefined' && !!chrome.storage?.local

const storageGet = hasStorage
  ? (key: string) => chrome.storage.local.get(key)
  : (key: string) => chrome.runtime.sendMessage({ type: 'GET_STORAGE', key })

const storageSet = hasStorage
  ? (items: Record<string, unknown>) => chrome.storage.local.set(items)
  : (items: Record<string, unknown>) => chrome.runtime.sendMessage({ type: 'SET_STORAGE', items }).then(() => undefined)

export async function getProfile(): Promise<UserProfile | null> {
  const result = await storageGet(KEYS.profile)
  return result[KEYS.profile] ?? null
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  await storageSet({ [KEYS.profile]: profile })
}

// --- Cloud LLM profiles ---

export async function getLLMProfiles(): Promise<LLMProfile[]> {
  const result = await storageGet(KEYS.llmProfiles)
  return result[KEYS.llmProfiles] ?? []
}

export async function saveLLMProfiles(profiles: LLMProfile[]): Promise<void> {
  await storageSet({ [KEYS.llmProfiles]: profiles })
}

export async function getActiveProfileId(): Promise<string | null> {
  const result = await storageGet(KEYS.activeProfileId)
  return result[KEYS.activeProfileId] ?? null
}

export async function setActiveProfileId(id: string | null): Promise<void> {
  await storageSet({ [KEYS.activeProfileId]: id })
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
    const result = await storageGet(key)
    return result[key] ?? ''
  }

  const profiles = await getLLMProfiles()
  if (profiles.length > 0) {
    const activeId = await getActiveProfileId()
    const active = activeId ? profiles.find((p) => p.id === activeId) : profiles[0]
    return (active ?? profiles[0]).customPrompt ?? ''
  }

  const key = KEYS.customPrompt
  const result = await storageGet(key)
  return result[key] ?? ''
}

export async function saveCustomPrompt(prompt: string, backend?: LLMBackend): Promise<void> {
  if (backend === 'chrome-prompt') {
    await storageSet({ [KEYS.customPromptChrome]: prompt })
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

  await storageSet({ [KEYS.customPrompt]: prompt })
}

// Raw legacy access — used by migration only.
async function getLLMConfigRaw(): Promise<LLMConfig | null> {
  const result = await storageGet(KEYS.llmConfig)
  return result[KEYS.llmConfig] ?? null
}

// Keep for backwards compat — writes to legacy key too so old code paths
// that haven't migrated yet still work.
export async function saveLLMConfig(config: LLMConfig): Promise<void> {
  await storageSet({ [KEYS.llmConfig]: config })
}
