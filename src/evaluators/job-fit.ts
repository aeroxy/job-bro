import { buildMessages, runWithValidation, validateNumbers } from '@/lib/llm-client'
import type { JobFitResult } from '@/types/evaluation'
import type { LLMConfig, UserProfile } from '@/types/profile'

const SYSTEM_PROMPT = `You are a technical recruiter evaluating job fit.
Compare candidate skills/experience vs job requirements.
Output compact JSON only, no whitespace outside strings:
{"skill_match":0.0,"experience_match":0.0,"overall_fit":0.0,"matching_skills":[],"gaps":[],"strengths":[],"summary":""}`

export async function runJobFitEvaluator(
  jobMarkdown: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt?: string
): Promise<JobFitResult> {
  const parts: string[] = [`<jd>\n${jobMarkdown}\n</jd>`]
  if (profile.resume.trim()) parts.push(`<resume>\n${profile.resume.trim()}\n</resume>`)
  if (profile.projects.trim()) parts.push(`<projects>\n${profile.projects.trim()}\n</projects>`)

  const messages = buildMessages(customPrompt, SYSTEM_PROMPT, parts.join('\n\n'))

  return runWithValidation<JobFitResult>(
    config,
    messages,
    (r) =>
      validateNumbers(r as Record<string, unknown>, ['skill_match', 'experience_match', 'overall_fit']) ??
      (Array.isArray(r.gaps) && Array.isArray(r.strengths) && Array.isArray(r.matching_skills)
        ? null
        : '"gaps", "strengths", "matching_skills" must be arrays')
  )
}
