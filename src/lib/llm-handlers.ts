// Shared LLM orchestration callable from either the background service worker
// (HTTP backend) or the sidepanel window (Chrome built-in AI backend).
// Pure functions — no chrome.runtime messaging here.

import { runResumeGenerator } from '@/evaluators/resume'
import { runAllEvaluators } from '@/evaluators/runner'
import { jobToMarkdown } from '@/extractor/markdown'
import { SYSTEM_PROMPT_SEPARATOR } from '@/lib/chrome-prompt-client'
import { chatCompletion } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import { getCustomPrompt, getLLMConfig, getProfile } from '@/lib/storage'
import type { AggregatedReport } from '@/types/evaluation'
import type { ExtractedJob } from '@/types/job'
import type { ChatTurn } from '@/types/chat'
import type { UserProfile } from '@/types/profile'

export type AnalyzeResult =
  | { ok: true; report: AggregatedReport }
  | { ok: false; error: string }

export type ResumeResult =
  | { ok: true; markdown: string; summary: string }
  | { ok: false; error: string }

export type ChatResult =
  | { ok: true; answer: string }
  | { ok: false; error: string }

export type ProgressCallback = (evaluator: string, status: 'running' | 'completed' | 'error') => void

async function loadConfigAndProfile(): Promise<
  | { ok: true; profile: UserProfile; config: NonNullable<Awaited<ReturnType<typeof getLLMConfig>>>; customPrompt: string }
  | { ok: false; error: string }
> {
  const profile = await getProfile()
  if (!profile) return { ok: false, error: 'No profile configured. Set up your profile first.' }

  const config = await getLLMConfig()
  if (!config) return { ok: false, error: 'No LLM configured. Open Settings.' }

  // openai backend requires base_url + model; chrome backend doesn't.
  if ((config.backend ?? 'openai') === 'openai') {
    if (!config.base_url || !config.model) {
      return { ok: false, error: 'No LLM configured. Set up base URL and model in Settings.' }
    }
  }

  const customPrompt = await getCustomPrompt(config.backend)
  return { ok: true, profile, config, customPrompt }
}

export async function runAnalysis(
  job: ExtractedJob,
  signal: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<AnalyzeResult> {
  const loaded = await loadConfigAndProfile()
  if (!loaded.ok) return loaded

  try {
    const report = await runAllEvaluators(
      job,
      loaded.profile,
      loaded.config,
      loaded.customPrompt || undefined,
      onProgress,
      signal,
    )
    return { ok: true, report }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function runResume(
  job: ExtractedJob,
  analysisContext?: string,
  previousResume?: string,
  previousSummary?: string,
  comment?: string,
  qnaHistory?: ChatTurn[],
): Promise<ResumeResult> {
  const loaded = await loadConfigAndProfile()
  if (!loaded.ok) return loaded

  try {
    const jobMarkdown = jobToMarkdown(job)
    const result = await runResumeGenerator(
      jobMarkdown,
      loaded.profile,
      loaded.config,
      loaded.customPrompt || undefined,
      analysisContext,
      previousResume,
      previousSummary,
      comment,
      qnaHistory,
    )
    return { ok: true, markdown: result.resume, summary: result.summary }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// Single combined system prompt for the Chrome chat path. Chrome's
// LanguageModel only accepts one system message, so the custom user prompt and
// the built-in chat system prompt — which the cloud path sends as two separate
// system messages in runChat — must be folded here. Uses the same separator
// chatCompletionChrome's splitMessages would have used, so the two backends
// produce byte-identical system content.
export function buildChromeChatSystemPrompt(
  customPrompt: string | undefined,
  profile: UserProfile,
  jobMarkdown: string,
  analysisContext: string,
): string {
  const parts: string[] = []
  if (customPrompt?.trim()) parts.push(customPrompt.trim())
  parts.push(buildChatSystemPrompt(profile, jobMarkdown, analysisContext))
  return parts.join(SYSTEM_PROMPT_SEPARATOR)
}

export function buildChatSystemPrompt(profile: UserProfile, jobMarkdown: string, analysisContext: string): string {
  const parts: string[] = [
    `You are an AI career advisor helping a candidate evaluate a job opportunity. You have already analyzed this job posting and produced a detailed report. The candidate is asking follow-up questions.

Answer concisely and directly. Use markdown formatting when helpful (lists, bold, etc). Draw on all available context: the job description, the candidate's profile, and the completed analysis. Avoid markdown tables — the display area is narrow; use bullet lists or plain sentences instead.`,
    '',
    `<job_description>\n${jobMarkdown}\n</job_description>`,
    '',
    `<candidate_resume>\n${profile.resume.trim()}\n</candidate_resume>`,
  ]

  if (profile.projects.trim()) {
    parts.push('', `<candidate_projects>\n${profile.projects.trim()}\n</candidate_projects>`)
  }

  const prefs = profile.preferences
  const remoteLabel = prefs.remote_preference === 'no_preference' ? 'No Preference' : prefs.remote_preference
  const sizeLabel = prefs.company_size_preference === 'no_preference' ? 'No Preference' : prefs.company_size_preference

  parts.push('', `<candidate_preferences>
Salary expectation: ${profile.salary_expectation.trim() || 'Not specified'}
Remote preference: ${remoteLabel}
Location preference: ${prefs.preferred_locations.trim() || 'Not specified'}
Company size: ${sizeLabel}
Industries: ${prefs.industries_of_interest.trim() || 'Not specified'}
Deal breakers: ${prefs.deal_breakers.trim() || 'None specified'}
Years of experience: ${prefs.years_of_experience}
</candidate_preferences>`)

  parts.push('', `<analysis_report>\n${analysisContext}\n</analysis_report>`)

  return parts.join('\n')
}

export async function runChat(
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  jobMarkdown: string,
  analysisContext: string,
): Promise<ChatResult> {
  const loaded = await loadConfigAndProfile()
  if (!loaded.ok) return loaded

  const messages: ChatMessage[] = []
  if (loaded.customPrompt?.trim()) {
    messages.push({ role: 'system', content: loaded.customPrompt.trim() })
  }
  messages.push({ role: 'system', content: buildChatSystemPrompt(loaded.profile, jobMarkdown, analysisContext) })
  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.content })
  }
  messages.push({ role: 'user', content: question })

  try {
    const answer = await chatCompletion(loaded.config, messages, {
      json_mode: false,
      max_tokens: 1500,
      temperature: 0.4,
    })
    return { ok: true, answer }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
