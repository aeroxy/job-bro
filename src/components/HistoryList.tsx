import { ArrowLeft, Building2, Clock, Trash2, Check, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { VerdictBadge } from './VerdictBadge'
import { type GroupedRecord, useHistory } from '@/hooks/useHistory'
import { useAutoResetState } from '@/hooks/useAutoResetState'
import { Spinner } from '@/components/ui/spinner'

interface HistoryListProps {
  onSelect: (id: string) => void
  onBack: () => void
  onRestore?: (jobId: string) => void
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function GroupRow({
  group,
  onSelect,
  onDelete,
  confirmingId,
}: {
  group: GroupedRecord
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  confirmingId: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const hasHistory = group.count > 1

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="p-3 hover:bg-muted/50 transition-colors group flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 flex items-start gap-1.5">
          {hasHistory && (
            <button
              type="button"
              aria-label={expanded ? 'Collapse history' : 'Expand history'}
              className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground mt-0.5"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
          )}
          <div
            className="min-w-0 flex-1 cursor-pointer"
            onClick={() => onSelect(group.latest.id)}
          >
            <div className="flex items-center gap-1.5">
              <h4 className="text-xs font-medium truncate">{group.job.title}</h4>
              {hasHistory && (
                <span className="shrink-0 text-[10px] text-muted-foreground bg-muted rounded px-1 py-0.5">
                  {group.count}x
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
              <span className="inline-flex items-start gap-0.5">
                <Building2 className="size-2.5 shrink-0 mt-0.5" />
                {group.job.company}
              </span>
              <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
                <Clock className="size-2.5" />
                {timeAgo(group.latest.createdAt)}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <VerdictBadge
            verdict={group.latest.report.verdict}
            score={group.latest.report.overall_score}
            size="sm"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onDelete(group.latest.id)}
            className={`cursor-pointer size-7 rounded-md transition-all duration-200 ${
              confirmingId === group.latest.id
                ? 'bg-destructive/10 text-destructive opacity-100'
                : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-destructive/10 hover:text-destructive'
            }`}
          >
            {confirmingId === group.latest.id ? (
              <Check className="size-3.5 text-destructive animate-scale-in" />
            ) : (
              <Trash2 className="size-3.5 text-muted-foreground" />
            )}
          </Button>
        </div>
      </div>

      {expanded && hasHistory && (
        <div className="border-t bg-muted/30 px-3 py-1.5 space-y-1">
          {group.records.slice(1).map((record) => (
            <div
              key={record.id}
              className="flex items-center justify-between gap-2 py-1 px-1 rounded hover:bg-muted/50 group/sub"
            >
              <div
                className="min-w-0 flex-1 flex items-center gap-2 text-[10px] text-muted-foreground cursor-pointer"
                onClick={() => onSelect(record.id)}
              >
                <RotateCcw className="size-2.5 shrink-0" />
                <span className="truncate">{formatTime(record.createdAt)}</span>
              </div>
              <div className="flex items-center gap-1">
                <VerdictBadge
                  verdict={record.report.verdict}
                  score={record.report.overall_score}
                  size="sm"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onDelete(record.id)}
                  className={`cursor-pointer size-5 rounded transition-all duration-200 ${
                    confirmingId === record.id
                      ? 'bg-destructive/10 text-destructive opacity-100'
                      : 'opacity-0 group-hover/sub:opacity-100 focus-visible:opacity-100 hover:bg-destructive/10 hover:text-destructive'
                  }`}
                >
                  {confirmingId === record.id ? (
                    <Check className="size-3 text-destructive animate-scale-in" />
                  ) : (
                    <Trash2 className="size-3 text-muted-foreground" />
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function HistoryList({ onSelect, onBack, onRestore: _onRestore }: HistoryListProps) {
  const { grouped, orphanCount, loading, remove, clearAll, prune } = useHistory()
  const [confirmingId, setConfirmingId] = useAutoResetState<string | null>(null)
  const [confirmingPrune, setConfirmingPrune] = useAutoResetState(false)
  const [confirmingClearAll, setConfirmingClearAll] = useAutoResetState(false)
  const [error, setError] = useAutoResetState<string | null>(null, 5000)

  return (
    <div className="flex flex-col h-screen bg-background">
      <header className="flex flex-col border-b">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" onClick={onBack} className="cursor-pointer">
              <ArrowLeft className="size-3.5" />
            </Button>
            <span className="text-sm font-medium">History</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={orphanCount === 0}
              onClick={async () => {
                if (confirmingPrune) {
                  try {
                    await prune()
                  } catch (e) {
                    setError(`Prune failed: ${(e as Error).message}`)
                  }
                  setConfirmingPrune(false)
                } else {
                  setConfirmingPrune(true)
                }
              }}
              className={`text-xs cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 ${
                confirmingPrune
                  ? 'bg-destructive/10 text-destructive hover:text-destructive'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {confirmingPrune ? 'Confirm Prune' : `Prune (${orphanCount})`}
            </Button>
            {grouped.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (confirmingClearAll) {
                    try {
                      await clearAll()
                    } catch (e) {
                      setError(`Clear all failed: ${(e as Error).message}`)
                    }
                    setConfirmingClearAll(false)
                  } else {
                    setConfirmingClearAll(true)
                  }
                }}
                className={`text-xs cursor-pointer transition-all duration-200 ${
                  confirmingClearAll
                    ? 'bg-destructive/10 text-destructive hover:bg-destructive/20'
                    : 'text-destructive hover:text-destructive'
                }`}
              >
                {confirmingClearAll ? 'Confirm Clear All' : 'Clear All'}
              </Button>
            )}
          </div>
        </div>
        {error && (
          <div className="bg-destructive/10 text-destructive text-[10px] px-3 py-1.5 border-t animate-in fade-in slide-in-from-top-1">
            {error}
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : grouped.length === 0 ? (
          <div className="text-center text-muted-foreground text-xs py-8">
            No analyses yet
          </div>
        ) : (
          <div className="space-y-2">
            {grouped.map((group) => (
              <GroupRow
                key={group.jobId}
                group={group}
                onSelect={onSelect}
                onDelete={async (id) => {
                  if (confirmingId === id) {
                    setConfirmingId(null)
                    try {
                      await remove(id)
                    } catch (e) {
                      setError(`Delete failed: ${(e as Error).message}`)
                    }
                  } else {
                    setConfirmingId(id)
                  }
                }}
                confirmingId={confirmingId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
