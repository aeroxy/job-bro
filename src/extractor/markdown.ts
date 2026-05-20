import type { ExtractedJob } from '@/types/job'

export function jobToMarkdown(job: ExtractedJob): string {
  const parts: string[] = []

  parts.push(`# ${job.title}`)
  parts.push(`**Company:** ${job.company}`)

  if (job.location) {
    parts.push(`**Location:** ${job.location}`)
  }

  parts.push('')
  parts.push('## Description')
  parts.push(job.description)

  return parts.join('\n')
}
