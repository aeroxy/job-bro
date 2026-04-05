import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { JobPreferences, UserProfile } from '@/types/profile'

interface ProfileFormProps {
  profile: UserProfile
  onSave: (profile: UserProfile) => Promise<void>
  onBack: () => void
}

export function ProfileForm({ profile, onSave, onBack }: ProfileFormProps) {
  const [form, setForm] = useState<UserProfile>(profile)
  const [saving, setSaving] = useState(false)

  const updatePrefs = (updates: Partial<JobPreferences>) => {
    setForm((prev) => ({
      ...prev,
      preferences: { ...prev.preferences, ...updates },
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    await onSave(form)
    setSaving(false)
    onBack()
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="cursor-pointer">
          <ArrowLeft className="size-3.5" />
        </Button>
        <span className="text-sm font-medium">Profile</span>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs">Resume</Label>
          <Textarea
            placeholder="Paste your resume here (markdown supported)..."
            value={form.resume}
            onChange={(e) => setForm((p) => ({ ...p, resume: e.target.value }))}
            className="min-h-32 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Salary Expectation</Label>
          <Input
            placeholder='e.g. "$150k-$180k base + equity"'
            value={form.salary_expectation}
            onChange={(e) => setForm((p) => ({ ...p, salary_expectation: e.target.value }))}
            className="text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Notable Projects</Label>
          <Textarea
            placeholder="Describe your key projects..."
            value={form.projects}
            onChange={(e) => setForm((p) => ({ ...p, projects: e.target.value }))}
            className="min-h-20 text-xs"
          />
        </div>

        <div className="border-t pt-3">
          <h3 className="text-xs font-semibold mb-3">Preferences</h3>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Remote Preference</Label>
              <select
                value={form.preferences.remote_preference}
                onChange={(e) => updatePrefs({ remote_preference: e.target.value as JobPreferences['remote_preference'] })}
                className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-xs"
              >
                <option value="any">Any</option>
                <option value="remote">Remote</option>
                <option value="hybrid">Hybrid</option>
                <option value="onsite">On-site</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Preferred Locations</Label>
              <Input
                placeholder="San Francisco, New York (comma separated)"
                value={form.preferences.preferred_locations.join(', ')}
                onChange={(e) =>
                  updatePrefs({
                    preferred_locations: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                className="text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Company Size</Label>
              <select
                value={form.preferences.company_size_preference}
                onChange={(e) =>
                  updatePrefs({ company_size_preference: e.target.value as JobPreferences['company_size_preference'] })
                }
                className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-xs"
              >
                <option value="any">Any</option>
                <option value="startup">Startup</option>
                <option value="mid">Mid-size</option>
                <option value="large">Large/Enterprise</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Industries of Interest</Label>
              <Input
                placeholder="AI/ML, fintech, healthcare (comma separated)"
                value={form.preferences.industries_of_interest.join(', ')}
                onChange={(e) =>
                  updatePrefs({
                    industries_of_interest: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                className="text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Deal Breakers</Label>
              <Input
                placeholder='e.g. "no equity", "travel > 25%" (comma separated)'
                value={form.preferences.deal_breakers.join(', ')}
                onChange={(e) =>
                  updatePrefs({
                    deal_breakers: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                className="text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Years of Experience</Label>
              <Input
                type="number"
                min={0}
                placeholder="0"
                value={form.preferences.years_of_experience || ''}
                onChange={(e) =>
                  updatePrefs({ years_of_experience: parseInt(e.target.value) || 0 })
                }
                className="text-xs"
              />
            </div>
          </div>
        </div>
      </div>

      <footer className="border-t p-3">
        <Button onClick={handleSave} disabled={saving} className="w-full cursor-pointer" size="sm">
          {saving ? 'Saving...' : 'Save Profile'}
        </Button>
      </footer>
    </div>
  )
}
