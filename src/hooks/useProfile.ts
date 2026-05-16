import { useCallback, useEffect, useState } from 'react'

import {
  getActiveProfileId,
  getCustomPrompt,
  getLLMConfig,
  getLLMProfiles,
  getProfile,
  migrateLLMProfiles,
  saveCustomPrompt,
  saveLLMConfig,
  saveLLMProfiles,
  saveProfile,
  setActiveProfileId,
} from '@/lib/storage'
import type { LLMConfig, LLMProfile, UserProfile } from '@/types/profile'
import { DEFAULT_PREFERENCES } from '@/types/profile'

export function useProfile() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null)
  const [llmProfiles, setLlmProfiles] = useState<LLMProfile[]>([])
  const [activeProfileIdState, setActiveProfileIdState] = useState<string | null>(null)
  const [customPromptChrome, setCustomPromptChrome] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const profiles = await migrateLLMProfiles()
      const [p, c, activeId, cpChrome] = await Promise.all([
        getProfile(),
        getLLMConfig(),
        getActiveProfileId(),
        getCustomPrompt('chrome-prompt'),
      ])
      setProfile(p)
      setLlmConfig(c)
      setLlmProfiles(profiles)
      setActiveProfileIdState(activeId)
      setCustomPromptChrome(cpChrome)
      setLoading(false)
    })()
  }, [])

  const updateProfile = useCallback(async (p: UserProfile) => {
    await saveProfile(p)
    setProfile(p)
  }, [])

  const updateLLMConfig = useCallback(async (c: LLMConfig) => {
    await saveLLMConfig(c)
    setLlmConfig(c)
  }, [])

  const updateCustomPromptChrome = useCallback(async (prompt: string) => {
    await saveCustomPrompt(prompt, 'chrome-prompt')
    setCustomPromptChrome(prompt)
  }, [])

  const saveLLMProfile = useCallback(async (updated: LLMProfile) => {
    const profiles = await getLLMProfiles()
    const idx = profiles.findIndex((p) => p.id === updated.id)
    if (idx >= 0) {
      profiles[idx] = updated
    } else {
      profiles.push(updated)
    }
    await saveLLMProfiles(profiles)
    await setActiveProfileId(updated.id)
    await saveLLMConfig(updated.config)
    setLlmProfiles(profiles)
    setActiveProfileIdState(updated.id)
    setLlmConfig(updated.config)
  }, [])

  const deleteLLMProfile = useCallback(async (id: string) => {
    const profiles = await getLLMProfiles()
    const filtered = profiles.filter((p) => p.id !== id)
    if (filtered.length === 0) return
    await saveLLMProfiles(filtered)

    let newActiveId = activeProfileIdState
    if (newActiveId === id) {
      newActiveId = filtered[0].id
      await setActiveProfileId(newActiveId)
      await saveLLMConfig(filtered[0].config)
      setLlmConfig(filtered[0].config)
      setActiveProfileIdState(newActiveId)
    }
    setLlmProfiles(filtered)
  }, [activeProfileIdState])

  const selectLLMProfile = useCallback(async (id: string) => {
    const profiles = await getLLMProfiles()
    const target = profiles.find((p) => p.id === id)
    if (!target) return
    await setActiveProfileId(id)
    await saveLLMConfig(target.config)
    setActiveProfileIdState(id)
    setLlmConfig(target.config)
  }, [])

  const activeLLMProfile = llmProfiles.find((p) => p.id === activeProfileIdState) ?? llmProfiles[0] ?? null

  const isProfileComplete = profile !== null && !!profile.resume.trim()
  const isLLMConfigured =
    llmConfig !== null &&
    (llmConfig.backend === 'chrome-prompt'
      ? true
      : !!llmConfig.base_url.trim() && !!llmConfig.model.trim())

  const activeBackend = llmConfig?.backend ?? 'openai'
  const activeCustomPrompt = activeBackend === 'chrome-prompt'
    ? customPromptChrome
    : (activeLLMProfile?.customPrompt ?? '')

  return {
    profile: profile ?? {
      resume: '',
      salary_expectation: '',
      projects: '',
      preferences: DEFAULT_PREFERENCES,
    },
    llmConfig: llmConfig ?? { base_url: '', model: '' },
    llmProfiles,
    activeLLMProfile,
    activeProfileId: activeProfileIdState,
    customPromptChrome,
    activeCustomPrompt,
    loading,
    isProfileComplete,
    isLLMConfigured,
    updateProfile,
    updateLLMConfig,
    updateCustomPromptChrome,
    saveLLMProfile,
    deleteLLMProfile,
    selectLLMProfile,
  }
}
