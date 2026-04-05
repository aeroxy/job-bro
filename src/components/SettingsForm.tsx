import { ArrowLeft, Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { LLMConfig } from '@/types/profile'

interface SettingsFormProps {
  llmConfig: LLMConfig
  customPrompt: string
  onSaveLLM: (config: LLMConfig) => Promise<void>
  onSavePrompt: (prompt: string) => Promise<void>
  onBack: () => void
}

export function SettingsForm({
  llmConfig,
  customPrompt,
  onSaveLLM,
  onSavePrompt,
  onBack,
}: SettingsFormProps) {
  const [config, setConfig] = useState<LLMConfig>(llmConfig)
  const [prompt, setPrompt] = useState(customPrompt)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    await Promise.all([onSaveLLM(config), onSavePrompt(prompt)])
    setSaving(false)
    onBack()
  }

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
          <h3 className="text-xs font-semibold mb-3">LLM Configuration</h3>

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
          </div>
        </div>

        <div className="border-t pt-3">
          <h3 className="text-xs font-semibold mb-3">Custom System Prompt</h3>
          <Textarea
            placeholder="Optional: prepended to all evaluator prompts..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="min-h-20 text-xs"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            Prepended to every evaluator's system prompt. Add context about your background or evaluation preferences.
          </p>
        </div>
      </div>

      <footer className="border-t p-3">
        <Button
          onClick={handleSave}
          disabled={saving || !config.base_url.trim() || !config.model.trim()}
          className="w-full cursor-pointer"
          size="sm"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </footer>
    </div>
  )
}
