import { ArrowLeft, Cloud, Cpu, Download, Eye, EyeOff, Trash2, CheckCircle2, AlertCircle, RefreshCw, Key, Fingerprint } from 'lucide-react'
import { useState, useEffect } from 'react'

import { QwenIcon } from '@/components/icons/QwenIcon'
import { getQwenToken, updateQwenCookies } from '@/lib/qwen/qwen-service'
import { generateCookies } from '@/lib/qwen/cookie-generator'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useChromeAiStatus } from '@/hooks/useChromeAiStatus'
import type { LLMBackend, LLMConfig, LLMProfile } from '@/types/profile'

interface SettingsFormProps {
  llmConfig: LLMConfig
  llmProfiles: LLMProfile[]
  activeProfileId: string | null
  customPromptChrome: string
  onSaveLLMProfile: (profile: LLMProfile) => Promise<void>
  onDeleteLLMProfile: (id: string) => Promise<void>
  onSelectLLMProfile: (id: string) => Promise<void>
  onSavePromptChrome: (prompt: string) => Promise<void>
  onBack: () => void
}

export function SettingsForm({
  llmConfig,
  llmProfiles,
  activeProfileId,
  customPromptChrome,
  onSaveLLMProfile,
  onDeleteLLMProfile,
  onSelectLLMProfile: _onSelectLLMProfile,
  onSavePromptChrome,
  onBack,
}: SettingsFormProps) {
  const [config, setConfig] = useState<LLMConfig>(llmConfig)
  const [profileName, setProfileName] = useState(() => {
    const active = llmProfiles.find((p) => p.id === activeProfileId) ?? llmProfiles[0]
    return active?.name ?? ''
  })
  const [promptCloud, setPromptCloud] = useState(() => {
    const active = llmProfiles.find((p) => p.id === activeProfileId) ?? llmProfiles[0]
    return active?.customPrompt ?? ''
  })
  const [promptChrome, setPromptChrome] = useState(customPromptChrome)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)

  const chromeAi = useChromeAiStatus()
  const backend: LLMBackend = config.backend ?? 'openai'
  const providerMode: 'chrome' | 'api' | 'qwen-chat' =
    backend === 'chrome-prompt' ? 'chrome' :
    backend === 'qwen-chat' ? 'qwen-chat' : 'api'

  // Qwen Chat States
  const [qwenToken, setQwenToken] = useState<string | null>(null)
  const [checkingQwenToken, setCheckingQwenToken] = useState(false)
  const [updatingQwenFingerprint, setUpdatingQwenFingerprint] = useState(false)
  const [qwenFingerprint, setQwenFingerprint] = useState('')

  useEffect(() => {
    if (providerMode === 'qwen-chat') {
      handleCheckQwenToken()
      // Generate initial fingerprint for display
      try {
        const cookies = generateCookies()
        setQwenFingerprint(cookies.ssxmod_itna.slice(0, 32) + '...')
      } catch {}
    }
  }, [providerMode])

  const handleCheckQwenToken = async () => {
    setCheckingQwenToken(true)
    try {
      const activeToken = await getQwenToken()
      setQwenToken(activeToken)
    } catch (e) {
      console.error(e)
    } finally {
      setCheckingQwenToken(false)
    }
  }

  const handleUpdateQwenFingerprint = async () => {
    setUpdatingQwenFingerprint(true)
    try {
      await updateQwenCookies()
      const cookies = generateCookies()
      setQwenFingerprint(cookies.ssxmod_itna.slice(0, 32) + '...')
    } catch (e) {
      console.error(e)
    } finally {
      setUpdatingQwenFingerprint(false)
    }
  }

  const canSave = providerMode !== 'api'
    ? true
    : !!config.base_url.trim() && !!config.model.trim()

  const handleProfileSwitch = (id: string) => {
    if (id === '__new__') {
      const newProfile: LLMProfile = {
        id: crypto.randomUUID(),
        name: 'New Profile',
        config: { base_url: '', model: '', backend: 'openai' },
        customPrompt: '',
      }
      setConfig(newProfile.config)
      setProfileName(newProfile.name)
      setPromptCloud('')
      setActiveProfileIdLocal(newProfile.id)
    } else {
      const target = llmProfiles.find((p) => p.id === id)
      if (!target) return
      setConfig(target.config)
      setProfileName(target.name)
      setPromptCloud(target.customPrompt)
      setActiveProfileIdLocal(target.id)
    }
  }

  const [activeProfileIdLocal, setActiveProfileIdLocal] = useState(activeProfileId)

  const handleSave = async () => {
    setSaving(true)
    const profileId = activeProfileIdLocal ?? crypto.randomUUID()
    const profile: LLMProfile = {
      id: profileId,
      name: profileName.trim() || 'Untitled',
      config,
      customPrompt: promptCloud,
    }
    await Promise.all([
      onSaveLLMProfile(profile),
      onSavePromptChrome(promptChrome),
    ])
    setActiveProfileIdLocal(profile.id)
    setSaving(false)
    onBack()
  }

  const handleDelete = async () => {
    if (!activeProfileIdLocal || llmProfiles.length <= 1) return
    const remaining = llmProfiles.filter((p) => p.id !== activeProfileIdLocal)
    await onDeleteLLMProfile(activeProfileIdLocal)
    const next = remaining[0]
    setConfig(next.config)
    setProfileName(next.name)
    setPromptCloud(next.customPrompt)
    setActiveProfileIdLocal(next.id)
  }

  const currentProfileId = activeProfileIdLocal
  const isNewProfile = currentProfileId ? !llmProfiles.some((p) => p.id === currentProfileId) : true

  return (
    <div className="flex flex-col h-screen bg-background">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="cursor-pointer">
          <ArrowLeft className="size-3.5" />
        </Button>
        <span className="text-sm font-medium">Settings</span>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        <div>
          <h3 className="text-xs font-semibold mb-3">LLM Backend</h3>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <BackendOption
              icon={<Cloud className="size-3.5" />}
              label="Cloud"
              description="OpenAI API"
              selected={backend === 'openai'}
              disabled={false}
              onClick={() => setConfig((p) => ({ ...p, backend: 'openai' }))}
            />
            <BackendOption
              icon={<Cpu className="size-3.5" />}
              label="Chrome"
              description="Gemini Nano"
              selected={backend === 'chrome-prompt'}
              disabled={chromeAi.status === 'unavailable'}
              onClick={() => setConfig((p) => ({ ...p, backend: 'chrome-prompt' }))}
            />
            <BackendOption
              icon={<QwenIcon className="size-3.5" />}
              label="Qwen Chat"
              description="Direct browser"
              selected={backend === 'qwen-chat'}
              disabled={false}
              onClick={() => setConfig((p) => ({ ...p, backend: 'qwen-chat' }))}
            />
          </div>

          {chromeAi.status === 'unavailable' && (
            <p className="text-[10px] text-muted-foreground">
              Chrome built-in AI requires Chrome 127+ with Gemini Nano enabled at{' '}
              <code className="text-[10px]">chrome://flags/#prompt-api-for-gemini-nano</code>.
              Model size ~4&nbsp;GB.
            </p>
          )}
          {providerMode === 'chrome' && chromeAi.status === 'downloadable' && (
            <div className="border rounded-md p-2 text-[11px] space-y-1.5">
              <p className="text-muted-foreground">
                Gemini Nano isn't downloaded yet. Click below to start the ~4 GB download.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={chromeAi.startDownload}
                className="cursor-pointer h-7 text-[11px]"
              >
                <Download className="size-3" />
                Download model
              </Button>
            </div>
          )}
          {providerMode === 'chrome' && chromeAi.status === 'downloading' && (
            <div className="border rounded-md p-2 text-[11px] flex items-center gap-2">
              <Spinner className="size-3" />
              <span className="text-muted-foreground">
                Downloading Gemini Nano
                {typeof chromeAi.downloadProgress === 'number'
                  ? ` (${Math.round(chromeAi.downloadProgress * 100)}%)`
                  : '...'}
              </span>
            </div>
          )}
          {providerMode === 'chrome' && chromeAi.status === 'available' && (
            <p className="text-[10px] text-muted-foreground">
              Model: <span className="font-medium">Gemini Nano v3</span> · runs on-device, no network calls.
            </p>
          )}
          {providerMode === 'qwen-chat' && (
            <div className="space-y-3 pt-1">
              <p className="text-[10px] text-muted-foreground leading-normal">
                Uses your active browser session at <a href="https://chat.qwen.ai" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">chat.qwen.ai</a>. No API keys or external server proxy required!
              </p>

              {/* 1. Auth Status Row */}
              <div className="border rounded-md p-2 bg-slate-50 dark:bg-slate-900/40 space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[9px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Key className="size-3" /> Auth Status
                  </span>
                  <button
                    onClick={handleCheckQwenToken}
                    disabled={checkingQwenToken}
                    className="text-[9px] text-blue-500 hover:underline cursor-pointer flex items-center gap-0.5"
                  >
                    <RefreshCw className={`size-2.5 ${checkingQwenToken ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                </div>
                <div className="flex items-center gap-1.5 pt-0.5">
                  {qwenToken ? (
                    <>
                      <CheckCircle2 className="size-3.5 text-green-500 shrink-0" />
                      <span className="font-medium text-green-600 dark:text-green-400">Authenticated (Qwen Session Active)</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="size-3.5 text-amber-500 shrink-0" />
                      <span className="font-medium text-amber-600 dark:text-amber-400 text-left leading-normal">No active session. Please log in on Qwen.</span>
                    </>
                  )}
                </div>
              </div>

              {/* 2. Fingerprint Generator Row */}
              <div className="border rounded-md p-2 bg-slate-50 dark:bg-slate-900/40 space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[9px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Fingerprint className="size-3" /> Fingerprint Generator
                  </span>
                  <button
                    onClick={handleUpdateQwenFingerprint}
                    disabled={updatingQwenFingerprint}
                    className="text-[9px] text-blue-500 hover:underline cursor-pointer flex items-center gap-0.5"
                  >
                    <RefreshCw className={`size-2.5 ${updatingQwenFingerprint ? 'animate-spin' : ''}`} />
                    Update
                  </button>
                </div>
                <div className="font-mono text-[9px] p-1 bg-zinc-100 dark:bg-zinc-800 rounded-sm text-zinc-600 dark:text-zinc-400 truncate">
                  {qwenFingerprint || 'Not generated yet'}
                </div>
              </div>
            </div>
          )}
        </div>

        {providerMode === 'api' && (
          <div>
            <h3 className="text-xs font-semibold mb-3">Cloud LLM Profile</h3>

            <div className="space-y-3">
              <div className="flex gap-2">
                <select
                  value={currentProfileId ?? ''}
                  onChange={(e) => handleProfileSwitch(e.target.value)}
                  className="flex-1 rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
                >
                  {llmProfiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                  {isNewProfile && currentProfileId && (
                    <option value={currentProfileId}>{profileName || 'New Profile'}</option>
                  )}
                  <option value="__new__">+ New Profile</option>
                </select>
                {!isNewProfile && llmProfiles.length > 1 && (
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={handleDelete}
                    className="cursor-pointer shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3" />
                  </Button>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Profile Name</Label>
                <Input
                  placeholder="e.g. GPT-4o, Claude, OpenRouter"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  className="text-xs"
                />
              </div>
            </div>
          </div>
        )}

        {providerMode === 'api' && (
          <div>
            <h3 className="text-xs font-semibold mb-3">Configuration</h3>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">API Base URL</Label>
                <Input
                  placeholder="https://api.openai.com/v1"
                  value={config.base_url}
                  onChange={(e) => setConfig((p) => ({ ...p, base_url: e.target.value }))}
                  className="text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Model</Label>
                <Input
                  placeholder="gpt-4o"
                  value={config.model}
                  onChange={(e) => setConfig((p) => ({ ...p, model: e.target.value }))}
                  className="text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">
                  API Key
                  <span className="text-muted-foreground font-normal ml-1">(optional)</span>
                </Label>
                <div className="relative">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    placeholder="sk-... (leave blank if not required)"
                    value={config.api_key ?? ''}
                    onChange={(e) => setConfig((p) => ({ ...p, api_key: e.target.value || undefined }))}
                    className="text-xs pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">
                  Custom Headers
                  <span className="text-muted-foreground font-normal ml-1">(optional)</span>
                </Label>
                <Textarea
                  placeholder={'{"X-API-Key": "abc", "X-Custom": "value"}'}
                  value={config.custom_headers ?? ''}
                  onChange={(e) => setConfig((p) => ({ ...p, custom_headers: e.target.value || undefined }))}
                  className="text-xs min-h-12 font-mono"
                />
                <p className="text-[10px] text-muted-foreground">
                  JSON object of extra headers. Use for APIs that authenticate via headers instead of Bearer token.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Request Timeout (s)</Label>
                  <Input
                    type="number"
                    min={5}
                    placeholder="30"
                    value={config.timeout ?? ''}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        timeout: e.target.value ? Number(e.target.value) : undefined,
                      }))
                    }
                    className="text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {config.stream_mode ? 'Not used in stream mode' : 'Max wait for full response'}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Stream Timeout (s)</Label>
                  <Input
                    type="number"
                    min={5}
                    placeholder="60"
                    value={config.stream_timeout ?? ''}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        stream_timeout: e.target.value ? Number(e.target.value) : undefined,
                      }))
                    }
                    className="text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {config.stream_mode ? 'Max inactivity between chunks' : 'Not used without stream mode'}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Concurrency</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    placeholder="2"
                    value={config.concurrency ?? ''}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        concurrency: e.target.value ? (Number(e.target.value) || undefined) : undefined,
                      }))
                    }
                    className="text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Max parallel calls to this provider
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Max Tokens</Label>
                  <Input
                    type="number"
                    min={256}
                    placeholder="8192"
                    value={config.max_tokens ?? ''}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        max_tokens: e.target.value ? (Number(e.target.value) || undefined) : undefined,
                      }))
                    }
                    className="text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Completion budget. Raise for reasoning models
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Temperature</Label>
                  <Input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    placeholder="Provider default"
                    value={config.temperature ?? ''}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        temperature: e.target.value !== '' ? Number(e.target.value) : undefined,
                      }))
                    }
                    className="text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Leave blank to use the provider default
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {providerMode === 'api' && (
          <>
            <div className="flex items-center justify-between border-t pt-3">
              <div>
                <Label className="text-xs">Allow Tool Calls</Label>
                <p className="text-[10px] text-muted-foreground">
                  Let the model use web_search and read_page to look up companies, market data, etc.
                  Disable for local LLM servers that don&rsquo;t support function-calling — small models
                  (llama.cpp, older Ollama builds) often ignore the protocol or hallucinate tool calls.
                  When off, the agent loop runs a single call without tools.
                </p>
              </div>
              <Switch
                checked={config.tools_enabled !== false}
                onCheckedChange={(checked) => setConfig((p) => ({ ...p, tools_enabled: checked }))}
              />
            </div>
            <div className="flex items-center justify-between border-t pt-3">
              <div>
                <Label className="text-xs">Use Structured Output</Label>
                <p className="text-[10px] text-muted-foreground">
                  Send each evaluator a strict JSON Schema via{' '}
                  <code className="text-[10px]">response_format.json_schema</code> so the model can&rsquo;t
                  drift shape. Eliminates the &ldquo;fix your JSON&rdquo; retry path. Requires a provider
                  that supports the OpenAI json_schema format (OpenAI, Groq, Together, Fireworks, vLLM).
                  Disable for local servers that silently ignore unknown response_format fields.
                </p>
              </div>
              <Switch
                checked={config.structured_output === true}
                onCheckedChange={(checked) => setConfig((p) => ({ ...p, structured_output: checked }))}
              />
            </div>
            <div className="flex items-center justify-between border-t pt-3">
              <div>
                <Label className="text-xs">Stream Mode</Label>
                <p className="text-[10px] text-muted-foreground">
                  Use SSE streaming for LLM calls. Enable if you experience gateway timeouts on large requests.
                </p>
              </div>
              <Switch
                checked={config.stream_mode ?? false}
                onCheckedChange={(checked) => setConfig((p) => ({ ...p, stream_mode: checked }))}
              />
            </div>
          </>
        )}

        <div className="border-t pt-3">
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="text-xs font-semibold">
              Custom System Prompt
              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                ({providerMode === 'chrome' ? 'Chrome built-in AI' : providerMode === 'qwen-chat' ? 'Qwen Chat' : 'Cloud LLM'})
              </span>
            </h3>
          </div>
          {providerMode === 'chrome' ? (
            <>
              <Textarea
                placeholder="Optional: prepended to evaluator prompts when using Gemini Nano..."
                value={promptChrome}
                onChange={(e) => setPromptChrome(e.target.value)}
                className="min-h-20 text-xs"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Gemini Nano is small (~2 B params). Keep instructions short and directive — avoid nuanced multi-step
                reasoning that frontier models handle. Saved separately from the cloud prompt.
              </p>
            </>
          ) : (
            <>
              <Textarea
                placeholder="Optional: prepended to evaluator prompts when using Qwen/cloud model..."
                value={promptCloud}
                onChange={(e) => setPromptCloud(e.target.value)}
                className="min-h-20 text-xs"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Prepended to every evaluator's system prompt. Add context about your background or evaluation preferences.
                Saved per profile.
              </p>
            </>
          )}
        </div>
      </div>

      <footer className="border-t p-3">
        <Button
          onClick={handleSave}
          disabled={saving || !canSave}
          className="w-full cursor-pointer"
          size="sm"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </footer>
    </div>
  )
}

interface BackendOptionProps {
  icon: React.ReactNode
  label: string
  description: string
  selected: boolean
  disabled: boolean
  onClick: () => void
}

function BackendOption({ icon, label, description, selected, disabled, onClick }: BackendOptionProps) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={[
        'border rounded-md p-2 text-left transition-colors cursor-pointer',
        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
        disabled ? 'opacity-50 cursor-not-allowed' : '',
      ].join(' ')}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {icon}
        {label}
      </div>
      <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>
    </button>
  )
}
