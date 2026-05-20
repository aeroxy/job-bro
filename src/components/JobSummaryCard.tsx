import { Building2, MapPin } from 'lucide-react'

import type { ExtractedJob } from '@/types/job'

interface JobSummaryCardProps {
  job: ExtractedJob
}

export function JobSummaryCard({ job }: JobSummaryCardProps) {
  return (
    <div className="border rounded-lg p-3 space-y-2">
      <h3 className="text-sm font-semibold leading-tight">{job.title}</h3>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Building2 className="size-3" />
          {job.company}
        </span>
        {job.location && (
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3" />
            {job.location}
          </span>
        )}
      </div>
    </div>
  )
}
