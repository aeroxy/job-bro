import type { ExtractedJob } from '@/types/job'

export function jobToMarkdown(job: ExtractedJob): string {
  const parts: string[] = []

  parts.push(`# ${job.title}`)
  parts.push(`**Company:** ${job.company}`)

  if (job.location) {
    parts.push(`**Location:** ${job.location}`)
  }

  if (job.salary_range) {
    parts.push(`**Salary:** ${job.salary_range}`)
  }

  if (job.employment_type) {
    parts.push(`**Type:** ${job.employment_type}`)
  }

  if (job.experience_level) {
    parts.push(`**Level:** ${job.experience_level}`)
  }

  parts.push('')
  parts.push('## Description')
  parts.push(job.description)

  if (job.requirements.length > 0) {
    parts.push('')
    parts.push('## Requirements')
    for (const req of job.requirements) {
      parts.push(`- ${req}`)
    }
  }

  if (job.benefits.length > 0) {
    parts.push('')
    parts.push('## Benefits')
    for (const benefit of job.benefits) {
      parts.push(`- ${benefit}`)
    }
  }

  return parts.join('\n')
}
