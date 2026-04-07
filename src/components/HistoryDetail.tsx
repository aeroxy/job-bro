import { ArrowLeft } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { AnalysisRecord } from '@/lib/db'
import { useHistory } from '@/hooks/useHistory'
import { JobSummaryCard } from './JobSummaryCard'
import { AnalysisReport } from './AnalysisReport'

interface HistoryDetailProps {
  analysisId: string
  onBack: () => void
}

export function HistoryDetail({ analysisId, onBack }: HistoryDetailProps) {
  const { get } = useHistory()
  const [record, setRecord] = useState<AnalysisRecord | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    get(analysisId).then((r) => {
      setRecord(r ?? null)
      setLoading(false)
    })
  }, [analysisId, get])

  if (loading) {
    return (
      <div className="flex flex-col h-screen bg-background">
        <header className="flex items-center gap-2 border-b px-3 py-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack} className="cursor-pointer">
            <ArrowLeft className="size-3.5" />
          </Button>
          <span className="text-sm font-medium">Analysis Detail</span>
        </header>
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      </div>
    )
  }

  if (!record) {
    return (
      <div className="flex flex-col h-screen bg-background">
        <header className="flex items-center gap-2 border-b px-3 py-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack} className="cursor-pointer">
            <ArrowLeft className="size-3.5" />
          </Button>
          <span className="text-sm font-medium">Analysis Detail</span>
        </header>
        <div className="text-center text-muted-foreground text-xs py-8">
          Analysis not found
        </div>
      </div>
    )
  }

  // Build the completed progress from the report
  const progress = {
    job_fit: record.report.evaluators.job_fit.status === 'fulfilled' ? 'completed' as const : 'error' as const,
    salary: record.report.evaluators.salary.status === 'fulfilled' ? 'completed' as const : 'error' as const,
    preference: record.report.evaluators.preference.status === 'fulfilled' ? 'completed' as const : 'error' as const,
    risk: record.report.evaluators.risk.status === 'fulfilled' ? 'completed' as const : 'error' as const,
    growth: record.report.evaluators.growth.status === 'fulfilled' ? 'completed' as const : 'error' as const,
    summary: 'completed' as const,
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="cursor-pointer">
          <ArrowLeft className="size-3.5" />
        </Button>
        <span className="text-sm font-medium">Analysis Detail</span>
      </header>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <JobSummaryCard job={record.job} />
        <AnalysisReport report={record.report} progress={progress} analyzing={false} />
      </div>
    </div>
  )
}
