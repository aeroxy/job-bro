import { useCallback, useEffect, useState } from 'react'

import { getCustomPrompt, getLLMConfig, getProfile, saveCustomPrompt, saveLLMConfig, saveProfile } from '@/lib/storage'
import type { LLMConfig, UserProfile } from '@/types/profile'
import { DEFAULT_PREFERENCES } from '@/types/profile'

export function useProfile() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null)
  const [customPrompt, setCustomPromptState] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([getProfile(), getLLMConfig(), getCustomPrompt()]).then(
      ([p, c, cp]) => {
        setProfile(p)
        setLlmConfig(c)
        setCustomPromptState(cp)
        setLoading(false)
      }
    )
  }, [])

  const updateProfile = useCallback(async (p: UserProfile) => {
    await saveProfile(p)
    setProfile(p)
  }, [])

  const updateLLMConfig = useCallback(async (c: LLMConfig) => {
    await saveLLMConfig(c)
    setLlmConfig(c)
  }, [])

  const updateCustomPrompt = useCallback(async (prompt: string) => {
    await saveCustomPrompt(prompt)
    setCustomPromptState(prompt)
  }, [])

  const isProfileComplete = profile !== null && !!profile.resume.trim()
  const isLLMConfigured = llmConfig !== null && !!llmConfig.base_url.trim() && !!llmConfig.model.trim()

  return {
    profile: profile ?? {
      resume: '',
      salary_expectation: '',
      projects: '',
      preferences: DEFAULT_PREFERENCES,
    },
    llmConfig: llmConfig ?? { base_url: '', model: '' },
    customPrompt,
    loading,
    isProfileComplete,
    isLLMConfigured,
    updateProfile,
    updateLLMConfig,
    updateCustomPrompt,
  }
}
