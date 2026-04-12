import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react'
import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { UserProfile } from '@/types/profile'

interface ProfileFormProps {
  profile: UserProfile
  onSave: (profile: UserProfile) => Promise<void>
  onBack: () => void
}

export function ProfileForm({ profile, onSave, onBack }: ProfileFormProps) {
  const [saving, setSaving] = useState(false)
  const [resumeOpen, setResumeOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)

  const resumeRef = useRef<HTMLTextAreaElement>(null)
  const salaryRef = useRef<HTMLInputElement>(null)
  const projectsRef = useRef<HTMLTextAreaElement>(null)
  const remoteRef = useRef<HTMLSelectElement>(null)
  const locationsRef = useRef<HTMLInputElement>(null)
  const companySizeRef = useRef<HTMLSelectElement>(null)
  const industriesRef = useRef<HTMLInputElement>(null)
  const dealBreakersRef = useRef<HTMLInputElement>(null)
  const yearsRef = useRef<HTMLInputElement>(null)

  const handleSave = async () => {
    setSaving(true)
    await onSave({
      resume: resumeRef.current?.value ?? profile.resume,
      salary_expectation: salaryRef.current?.value ?? profile.salary_expectation,
      projects: projectsRef.current?.value ?? profile.projects,
      preferences: {
        remote_preference: (remoteRef.current?.value ?? profile.preferences.remote_preference) as UserProfile['preferences']['remote_preference'],
        preferred_locations: locationsRef.current?.value ?? profile.preferences.preferred_locations,
        company_size_preference: (companySizeRef.current?.value ?? profile.preferences.company_size_preference) as UserProfile['preferences']['company_size_preference'],
        industries_of_interest: industriesRef.current?.value ?? profile.preferences.industries_of_interest,
        deal_breakers: dealBreakersRef.current?.value ?? profile.preferences.deal_breakers,
        years_of_experience: parseInt(yearsRef.current?.value ?? '') || profile.preferences.years_of_experience,
      },
    })
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

        {/* Resume — collapsible, stays mounted */}
        <div className="space-y-1.5">
          <button type="button" onClick={() => setResumeOpen((o) => !o)} className="flex items-center gap-1 text-xs font-medium">
            {resumeOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Resume
          </button>
          <Textarea
            ref={resumeRef}
            placeholder="Paste your resume here (markdown supported)..."
            defaultValue={profile.resume}
            className={`min-h-32 text-xs ${resumeOpen ? '' : 'hidden'}`}
          />
        </div>

        {/* Projects + Salary grouped */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <button type="button" onClick={() => setProjectsOpen((o) => !o)} className="flex items-center gap-1 text-xs font-medium">
              {projectsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              Notable Projects
            </button>
            <Textarea
              ref={projectsRef}
              placeholder="Describe your key projects..."
              defaultValue={profile.projects}
              className={`min-h-20 text-xs ${projectsOpen ? '' : 'hidden'}`}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Salary Expectation</Label>
            <Input
              ref={salaryRef}
              placeholder='e.g. "$150k-$180k base + equity"'
              defaultValue={profile.salary_expectation}
              className="text-xs"
            />
          </div>
        </div>

        {/* Preferences */}
        <div className="border-t pt-3">
          <h3 className="text-xs font-semibold mb-3">Preferences</h3>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Remote Preference</Label>
              <select
                ref={remoteRef}
                defaultValue={profile.preferences.remote_preference}
                className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-xs"
              >
                <option value="no_preference">No Preference</option>
                <option value="remote">Remote</option>
                <option value="hybrid">Hybrid</option>
                <option value="onsite">On-site</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Preferred Locations</Label>
              <Input
                ref={locationsRef}
                placeholder="San Francisco, New York"
                defaultValue={profile.preferences.preferred_locations}
                className="text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Company Size</Label>
              <select
                ref={companySizeRef}
                defaultValue={profile.preferences.company_size_preference}
                className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-xs"
              >
                <option value="no_preference">No Preference</option>
                <option value="startup">Startup</option>
                <option value="mid">Mid-size</option>
                <option value="large">Large/Enterprise</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Industries of Interest</Label>
              <Input
                ref={industriesRef}
                placeholder="AI/ML, fintech, healthcare"
                defaultValue={profile.preferences.industries_of_interest}
                className="text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Deal Breakers</Label>
              <Input
                ref={dealBreakersRef}
                placeholder="no equity, travel > 25%"
                defaultValue={profile.preferences.deal_breakers}
                className="text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Years of Experience</Label>
              <Input
                ref={yearsRef}
                type="number"
                min={0}
                placeholder="0"
                defaultValue={profile.preferences.years_of_experience || ''}
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
