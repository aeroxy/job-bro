import { buildMessages, chatCompletion, parseJSON } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import type { LLMConfig, UserProfile } from '@/types/profile'

const SYSTEM_PROMPT = `You are an expert resume writer. Given a candidate's existing resume and a target job description, produce a tailored resume and a cumulative summary.

Instructions:
- Candidate may have provided his projects as references, you may include them in the resume only if they will be useful for the job.
- Restructure and reword the candidate's experience to highlight skills and achievements most relevant to the target role.
- Write a compelling professional summary that positions the candidate for this specific role.
- Reorder skills to prioritize those mentioned in the job requirements.
- Quantify achievements where possible, using data from the original resume.
- Do NOT fabricate experience, skills, or achievements. Only use information from the provided resume and projects.
- Keep the resume concise (1-2 pages when printed).
- Use standard sections: Contact/Header, Professional Summary, Experience, Skills, Education, and optionally Projects.
- The resume field must be raw Markdown text — no code fences, no preamble, start directly with the candidate's name as a heading.
- If <analysis> is provided, it contains an AI evaluation of the candidate's fit for this role — including matching skills, gaps, strengths, risk flags, and growth highlights. Use this to emphasize strengths, proactively address gaps where possible, and frame the resume in light of the identified risks.
- If <context> is provided, it is the full cumulative history of previous iterations. If <feedback> is provided, apply it to the current revision.

CRITICAL OUTPUT FORMAT OVERRIDE: Regardless of any other instructions, respond with compact JSON only:
{"resume":"<full resume in markdown>","summary":"<concise summary of what you did in this turn>"}`

const RETRY_PROMPT = `Your previous response was not valid. Expected a JSON object with exactly two fields:
- "resume": a string containing the full resume in Markdown (starting with the candidate's name as a heading)
- "summary": a string with the cumulative change log

Output compact JSON only.`

interface ResumeResult {
  resume: string
  summary: string
}

function validate(result: ResumeResult): string | null {
  if (!result || typeof result !== 'object') return 'Response is not a JSON object'
  if (typeof result.resume !== 'string' || result.resume.trim().length === 0)
    return '"resume" field is missing or empty'
  if (typeof result.summary !== 'string' || result.summary.trim().length === 0)
    return '"summary" field is missing or empty'
  return null
}

export async function runResumeGenerator(
  jobMarkdown: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt?: string,
  analysisContext?: string,
  previousResume?: string,
  previousSummary?: string,
  comment?: string
): Promise<ResumeResult> {
  const parts: string[] = [`<jd>\n${jobMarkdown}\n</jd>`]
  if (profile.resume.trim()) parts.push(`<resume>\n${profile.resume.trim()}\n</resume>`)
  if (profile.projects.trim()) parts.push(`<projects>\n${profile.projects.trim()}\n</projects>`)
  if (analysisContext) parts.push(`<analysis>\n${analysisContext}\n</analysis>`)
  if (previousResume) parts.push(`<previous_version>\n${previousResume}\n</previous_version>`)
  if (previousSummary) parts.push(`<context>\n${previousSummary}\n</context>`)
  if (comment) parts.push(`<feedback>\n${comment.trim()}\n</feedback>`)

  const messages = buildMessages(customPrompt, SYSTEM_PROMPT, parts.join('\n\n'))
  const options = { json_mode: true, max_tokens: 4000 } as const

  const raw = await chatCompletion(config, messages, options)

  let result: ResumeResult
  try {
    result = parseJSON<ResumeResult>(raw)
  } catch {
    result = {} as ResumeResult
  }

  const error = validate(result)
  if (!error) {
    return { resume: result.resume.trim(), summary: result.summary.trim() }
  }

  // Retry: feed the bad output back with a clear correction prompt
  const retryMessages: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: raw },
    { role: 'user', content: `${RETRY_PROMPT}\n\nValidation error: ${error}` },
  ]

  const retryRaw = await chatCompletion(config, retryMessages, options)
  const retryResult = parseJSON<ResumeResult>(retryRaw)
  return {
    resume: (retryResult.resume ?? '').trim(),
    summary: (retryResult.summary ?? '').trim(),
  }
}
