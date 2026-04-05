import { ArrowLeft, Building2, Clock, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { VerdictBadge } from './VerdictBadge'
import { useHistory } from '@/hooks/useHistory'
import { Spinner } from '@/components/ui/spinner'

interface HistoryListProps {
  onSelect: (id: string) => void
  onBack: () => void
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function HistoryList({ onSelect, onBack }: HistoryListProps) {
  const { records, loading, remove, clearAll } = useHistory()

  return (
    <div className="flex flex-col h-screen bg-background">
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack} className="cursor-pointer">
            <ArrowLeft className="size-3.5" />
          </Button>
          <span className="text-sm font-medium">History</span>
        </div>
        {records.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            className="text-xs text-destructive hover:text-destructive cursor-pointer"
          >
            Clear All
          </Button>
        )}
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
                      <span className="inline-flex items-center gap-0.5">
                        <Building2 className="size-2.5" />
                        {record.job.company}
                      </span>
                      <span className="inline-flex items-center gap-0.5">
                        <Clock className="size-2.5" />
                        {timeAgo(record.createdAt)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <VerdictBadge
                      verdict={record.report.verdict}
                      score={record.report.overall_score}
                      className="scale-75 origin-right"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        remove(record.id)
                      }}
                      className="opacity-0 group-hover:opacity-100 cursor-pointer size-6"
                    >
                      <Trash2 className="size-3 text-destructive" />
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
