import { chatCompletion } from '@/lib/llm-client'
import type { ChatMessage } from '@/lib/llm-client'
import type { LLMConfig, UserProfile } from '@/types/profile'
import type { ChatTurn } from '@/types/chat'

const DELIMITER = '---SUMMARY---'

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
- The resume must be raw Markdown text — no code fences, no preamble, start directly with the candidate's name as a heading.
- If <analysis> is provided, it contains an AI evaluation of the candidate's fit for this role — including matching skills, gaps, strengths, risk flags, and growth highlights. Use this to emphasize strengths, proactively address gaps where possible, and frame the resume in light of the identified risks.
- If <qna> is provided, it contains follow-up Q&A the candidate had with the analyst about this role — use it to surface clarifications, concerns, or angles the candidate cares about.
- If <context> is provided, it is the full cumulative history of previous iterations. If <feedback> is provided, apply it to the current revision.

CRITICAL OUTPUT FORMAT: Output the full resume as raw Markdown, then on its own line the exact delimiter ${DELIMITER}, then a concise summary of what you changed this turn. Nothing else. Example:

# Jane Doe
...rest of resume...

${DELIMITER}
Reordered skills to lead with X; quantified the Y achievement.`

const RETRY_PROMPT = `Your previous response was not valid. Output the full resume as raw Markdown (starting with the candidate's name as a heading), then on its own line the exact delimiter ${DELIMITER}, then the change log. No code fences, nothing before the resume.`

interface ResumeResult {
  resume: string
  summary: string
}

// Split the model output on the delimiter: everything before is the resume,
// everything after is the change-log summary. No delimiter → treat the whole
// thing as the resume with an empty summary (validate() then triggers a retry).
function splitResumeOutput(raw: string): ResumeResult {
  // Tolerate minor LLM formatting drift in the delimiter (case, surrounding
  // whitespace, dash count) so a near-miss doesn't cost a full retry.
  const match = raw.match(/---+\s*SUMMARY\s*---+/i)
  if (!match || match.index === undefined) return { resume: raw.trim(), summary: '' }
  return {
    resume: raw.slice(0, match.index).trim(),
    summary: raw.slice(match.index + match[0].length).trim(),
  }
}

function validate(result: ResumeResult): string | null {
  if (result.resume.length === 0) return 'resume is missing or empty'
  if (result.summary.length === 0) return `summary is missing — did you include the ${DELIMITER} delimiter?`
  return null
}

export async function runResumeGenerator(
  jobMarkdown: string,
  profile: UserProfile,
  config: LLMConfig,
  customPrompt: string,
  analysisContext?: string,
  previousResume?: string,
  previousSummary?: string,
  comment?: string,
  qnaHistory?: ChatTurn[],
  signal?: AbortSignal,
): Promise<ResumeResult> {
  const parts: string[] = [`<jd>\n${jobMarkdown}\n</jd>`]
  if (profile.resume.trim()) parts.push(`<resume>\n${profile.resume.trim()}\n</resume>`)
  if (profile.projects.trim()) parts.push(`<projects>\n${profile.projects.trim()}\n</projects>`)
  if (analysisContext) parts.push(`<analysis>\n${analysisContext}\n</analysis>`)
  if (qnaHistory && qnaHistory.length > 0) {
    const qnaText = qnaHistory.map(t => `${t.role === 'user' ? 'Q' : 'A'}: ${t.content}`).join('\n\n')
    parts.push(`<qna>\n${qnaText}\n</qna>`)
  }
  // if (previousResume) parts.push(`<previous_version>\n${previousResume}\n</previous_version>`)
  // if (previousSummary) parts.push(`<context>\n${previousSummary}\n</context>`)
  // if (comment) parts.push(`<feedback>\n${comment.trim()}\n</feedback>`)

  const messages: ChatMessage[] = []
  // const messages = buildMessages(customPrompt, SYSTEM_PROMPT, parts.join('\n\n'))
  // Build the messages array with custom prompt and internal prompt as separate system entries
  if (customPrompt) {
    messages.push({ role: 'system', content: customPrompt })
  }
  messages.push({ role: 'system', content: SYSTEM_PROMPT })
  messages.push({ role: 'system', content: parts.join('\n\n') })
  previousResume = previousResume && previousResume.trim()
  if (previousResume) {
    messages.push({ role: 'user', content: `<previous_version>\n${previousResume}\n</previous_version>` })
  }
  previousSummary = previousSummary && previousSummary.trim()
  if (previousSummary) {
    messages.push({ role: 'user', content: `<context>\n${previousSummary}\n</context>` })
  }
  comment = comment && comment.trim()
  if (comment) {
    messages.push({ role: 'user', content: `<feedback>\n${comment}\n</feedback>` })
  }
  // json_mode MUST be false: the prompt asks for raw Markdown + a delimiter,
  // not a JSON object. Leaving json_mode at its default (true) sends
  // response_format: { type: "json_object" }, which forces the model to emit
  // JSON and produce garbage. No max_tokens override either — resumes are
  // long-form, so let the client resolve config.max_tokens (default 8192).
  const options = { json_mode: false, signal } as const

  const raw = await chatCompletion(config, messages, options)
  const result = splitResumeOutput(raw)

  const error = validate(result)
  if (!error) return result

  // Retry: feed the bad output back with a clear correction prompt
  const retryMessages: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: raw },
    { role: 'user', content: `${RETRY_PROMPT}\n\nValidation error: ${error}` },
  ]

  const retryRaw = await chatCompletion(config, retryMessages, options)
  return splitResumeOutput(retryRaw)
}
