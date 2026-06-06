import * as Collapsible from '@radix-ui/react-collapsible'
import { BookOpen, ChevronDown, Globe, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'
import { StatusPill, type EvaluatorActivityView, type EvaluatorStatus } from './StatusPill'

interface EvaluatorCardProps {
  title: string
  icon: React.ReactNode
  status: EvaluatorStatus
  activity?: EvaluatorActivityView
  // True while the card has flipped to `completed` but the per-evaluator
  // result hasn't been written into the aggregated report yet (the report
  // lands in a single batch — see AnalysisReport.waitingFor). The card is
  // non-expandable in this state: the body would be empty, so we hide the
  // affordance and render the title row as a non-interactive label.
  waitingForContent?: boolean
  // Failure reason, surfaced when status === 'error'. Comes from the rejected
  // evaluator's EvaluatorStatus.error (see runner.runWithTracking).
  error?: string
  children: React.ReactNode
  className?: string
}

export function EvaluatorCard({
  title,
  icon,
  status,
  activity,
  waitingForContent,
  error,
  children,
  className,
}: EvaluatorCardProps) {
  const [open, setOpen] = useState(false)
  const hasContent = !waitingForContent && status === 'completed'

  if (!hasContent) {
    return (
      <div className={cn('border rounded-lg', className)}>
        <HeaderRow title={title} icon={icon} status={status} />
        <ActivityLine activity={activity} />
        {status === 'error' && error && <ErrorLine message={error} />}
      </div>
    )
  }

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className={cn('border rounded-lg', className)}>
        <Collapsible.Trigger className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/50 transition-colors cursor-pointer">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-muted-foreground">{icon}</span>
            <span className="text-xs font-medium">{title}</span>
            <StatusPill status={status} />
          </div>
          <ChevronDown
            className={cn(
              'size-3 text-muted-foreground transition-transform shrink-0',
              open && 'rotate-180'
            )}
          />
        </Collapsible.Trigger>
        <ActivityLine activity={activity} />
        <Collapsible.Content>
          <div className="px-3 pb-3 pt-1 border-t">
            {children}
          </div>
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  )
}

function HeaderRow({
  title,
  icon,
  status,
}: {
  title: string
  icon: React.ReactNode
  status: EvaluatorStatus
}) {
  return (
    <div className="w-full flex items-center px-3 py-2">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-xs font-medium">{title}</span>
        <StatusPill status={status} />
      </div>
    </div>
  )
}

// Sub-line that shows the failure reason for an errored evaluator.
function ErrorLine({ message }: { message: string }) {
  return (
    <div className="px-3 py-1.5 border-t text-[10px] text-red-700 dark:text-red-300 bg-red-50/50 dark:bg-red-900/20 break-words">
      {message}
    </div>
  )
}

// Sub-line that shows the in-flight tool call. Rendered in its own row so
// long queries / URLs don't crowd the evaluator title. Only shown while
// the agent loop has a tool dispatched.
function ActivityLine({ activity }: { activity?: EvaluatorActivityView }) {
  if (!activity) return null
  const Icon = activity.name === 'web_search' ? Globe : BookOpen
  return (
    <div
      key={activity.seq}
      className="flex items-center gap-1.5 px-3 py-1.5 border-t text-[10px] text-blue-700 dark:text-blue-300 bg-blue-50/50 dark:bg-blue-900/20 animate-in fade-in slide-in-from-top-1 duration-200"
    >
      <Loader2 className="size-2.5 animate-spin shrink-0" />
      <Icon className="size-2.5 shrink-0" />
      <span className="font-medium shrink-0">
        {activity.name === 'web_search' ? 'Searching' : 'Reading'}:
      </span>
      <span className="truncate" title={activity.display}>
        {activity.display}
      </span>
    </div>
  )
}
