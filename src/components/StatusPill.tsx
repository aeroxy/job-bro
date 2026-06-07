import { Check, Loader2, MinusCircle, X } from 'lucide-react'

export interface EvaluatorActivityView {
  name: 'web_search' | 'read_page'
  display: string
  seq: number
}

export type EvaluatorStatus = 'pending' | 'running' | 'completed' | 'error' | 'blocked'

// High-level status pill. Tool activity is shown in a separate sub-line
// below the title row (see EvaluatorCard.ActivityLine) so long queries /
// URLs don't crowd the title.
//
// `customLabel` lets the SummaryCard show "Synthesizing..." instead of
// "Analyzing..." while keeping the same visual treatment.
export function StatusPill({
  status,
  customLabel,
}: {
  status: EvaluatorStatus
  customLabel?: { running: string; queued: string; done: string; failed: string; blocked?: string }
}) {
  const labels = {
    running: customLabel?.running ?? 'Analyzing…',
    queued: customLabel?.queued ?? 'Queued',
    done: customLabel?.done ?? 'Done',
    failed: customLabel?.failed ?? 'Failed',
    blocked: customLabel?.blocked ?? 'Skipped',
  }

  if (status === 'running') {
    return (
      <span className="ml-1 inline-flex items-center gap-1 text-[10px] font-medium text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/40 px-1.5 py-0.5 rounded">
        <Loader2 className="size-2.5 animate-spin" />
        {labels.running}
      </span>
    )
  }
  if (status === 'completed') {
    return (
      <span className="ml-1 inline-flex items-center gap-1 text-[10px] font-medium text-green-700 dark:text-green-300 bg-green-100 dark:bg-green-900/40 px-1.5 py-0.5 rounded">
        <Check className="size-2.5" />
        {labels.done}
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="ml-1 inline-flex items-center gap-1 text-[10px] font-medium text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-900/40 px-1.5 py-0.5 rounded">
        <X className="size-2.5" />
        {labels.failed}
      </span>
    )
  }
  if (status === 'blocked') {
    return (
      <span className="ml-1 inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded">
        <MinusCircle className="size-2.5" />
        {labels.blocked}
      </span>
    )
  }
  return (
    <span className="ml-1 inline-flex items-center text-[10px] text-muted-foreground/70 px-1.5 py-0.5">
      {labels.queued}
    </span>
  )
}
