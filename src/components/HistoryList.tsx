import { ArrowLeft, Building2, Clock, Trash2, Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { VerdictBadge } from './VerdictBadge'
import { useHistory } from '@/hooks/useHistory'
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

export function HistoryList({ onSelect, onBack, onRestore }: HistoryListProps) {
  const { records, orphanCount, loading, remove, clearAll, prune } = useHistory()
  const [confirmingId, setConfirmingId] = useAutoResetState<string | null>(null)
  const [confirmingPrune, setConfirmingPrune] = useAutoResetState(false)
  const [confirmingClearAll, setConfirmingClearAll] = useAutoResetState(false)

  return (
    <div className="flex flex-col h-screen bg-background">
      <header className="flex items-center justify-between border-b px-3 py-2">
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
                  alert(`Prune failed: ${(e as Error).message}`)
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
          {records.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (confirmingClearAll) {
                  try {
                    await clearAll()
                  } catch (e) {
                    alert(`Clear all failed: ${(e as Error).message}`)
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
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : records.length === 0 ? (
          <div className="text-center text-muted-foreground text-xs py-8">
            No analyses yet
          </div>
        ) : (
          <div className="space-y-2">
            {records.map((record) => (
              <div
                key={record.id}
                className="border rounded-lg p-3 hover:bg-muted/50 transition-colors cursor-pointer group"
                onClick={() => onSelect(record.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h4 className="text-xs font-medium truncate">{record.job.title}</h4>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                      <span className="inline-flex items-start gap-0.5">
                        <Building2 className="size-2.5 shrink-0 mt-0.5" />
                        {record.job.company}
                      </span>
                      <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
                        <Clock className="size-2.5" />
                        {timeAgo(record.createdAt)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <VerdictBadge
                      verdict={record.report.verdict}
                      score={record.report.overall_score}
                      className="scale-75 origin-right"
                    />
                    <Button
                      variant="ghost"
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (confirmingId === record.id) {
                          try {
                            await remove(record.id)
                          } catch (e) {
                            alert(`Delete failed: ${(e as Error).message}`)
                          }
                          setConfirmingId(null)
                        } else {
                          setConfirmingId(record.id)
                        }
                      }}
                      className={`cursor-pointer size-7 rounded-md transition-all duration-200 ${
                        confirmingId === record.id
                          ? 'bg-destructive/10 text-destructive opacity-100'
                          : 'opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive'
                      }`}
                    >
                      {confirmingId === record.id ? (
                        <Check className="size-3.5 text-destructive animate-scale-in" />
                      ) : (
                        <Trash2 className="size-3.5 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
