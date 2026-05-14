import { useCallback, useEffect, useState } from 'react'

import { getCustomPrompt, getLLMConfig, getProfile, saveCustomPrompt, saveLLMConfig, saveProfile } from '@/lib/storage'
import type { LLMConfig, UserProfile } from '@/types/profile'
import { DEFAULT_PREFERENCES } from '@/types/profile'

export function useProfile() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null)
  const [customPromptCloud, setCustomPromptCloud] = useState('')
  const [customPromptChrome, setCustomPromptChrome] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      getProfile(),
      getLLMConfig(),
      getCustomPrompt('openai'),
      getCustomPrompt('chrome-prompt'),
    ]).then(([p, c, cpCloud, cpChrome]) => {
      setProfile(p)
      setLlmConfig(c)
      setCustomPromptCloud(cpCloud)
      setCustomPromptChrome(cpChrome)
      setLoading(false)
    })
  }, [])

  const updateProfile = useCallback(async (p: UserProfile) => {
    await saveProfile(p)
    setProfile(p)
  }, [])

  const updateLLMConfig = useCallback(async (c: LLMConfig) => {
    await saveLLMConfig(c)
    setLlmConfig(c)
  }, [])

  const updateCustomPromptCloud = useCallback(async (prompt: string) => {
    await saveCustomPrompt(prompt, 'openai')
    setCustomPromptCloud(prompt)
  }, [])

  const updateCustomPromptChrome = useCallback(async (prompt: string) => {
    await saveCustomPrompt(prompt, 'chrome-prompt')
    setCustomPromptChrome(prompt)
  }, [])

  const isProfileComplete = profile !== null && !!profile.resume.trim()
  const isLLMConfigured =
    llmConfig !== null &&
    (llmConfig.backend === 'chrome-prompt'
      ? true  // availability is checked at run time via useChromeAiStatus
      : !!llmConfig.base_url.trim() && !!llmConfig.model.trim())

  // Active prompt for the currently-selected backend — what evaluators / chat
  // will actually use. Components that just need "the right prompt" should
  // read this rather than the per-backend fields.
  const activeBackend = llmConfig?.backend ?? 'openai'
  const activeCustomPrompt = activeBackend === 'chrome-prompt' ? customPromptChrome : customPromptCloud

  return {
    profile: profile ?? {
      resume: '',
      salary_expectation: '',
      projects: '',
      preferences: DEFAULT_PREFERENCES,
    },
    llmConfig: llmConfig ?? { base_url: '', model: '' },
    customPromptCloud,
    customPromptChrome,
    activeCustomPrompt,
    loading,
    isProfileComplete,
    isLLMConfigured,
    updateProfile,
    updateLLMConfig,
    updateCustomPromptCloud,
    updateCustomPromptChrome,
  }
}
