import type { AggregatedReport } from '@/types/evaluation'

export function formatAnalysisContext(report: AggregatedReport): string {
  const lines: string[] = []
  lines.push(`Verdict: ${report.verdict} (score ${report.overall_score}/100)`)
  lines.push(`Overall reasoning: ${report.reasoning}`)

  const jf = report.evaluators.job_fit.result
  if (jf) {
    lines.push(`Job fit — overall: ${Math.round(jf.overall_fit * 100)}%, skill match: ${Math.round(jf.skill_match * 100)}%, experience match: ${Math.round(jf.experience_match * 100)}%`)
    if (jf.matching_skills.length) lines.push(`Matching skills: ${jf.matching_skills.join(', ')}`)
    if (jf.strengths.length) lines.push(`Strengths: ${jf.strengths.join(', ')}`)
    if (jf.gaps.length) lines.push(`Gaps: ${jf.gaps.join(', ')}`)
  }

  const risk = report.evaluators.risk.result
  if (risk) {
    lines.push(`Risk: ${risk.overall_risk} — ${risk.summary}`)
    for (const f of risk.flags) {
      if (f.severity !== 'low') lines.push(`  Risk flag (${f.severity}): ${f.description}`)
    }
  }

  const growth = report.evaluators.growth.result
  if (growth) {
    if (growth.highlights.length) lines.push(`Growth highlights: ${growth.highlights.join(', ')}`)
    if (growth.concerns.length) lines.push(`Growth concerns: ${growth.concerns.join(', ')}`)
  }

  if (report.key_risks.length) lines.push(`Key risks: ${report.key_risks.join('; ')}`)

  return lines.join('\n')
}
