import { cn } from '@/lib/utils'
import type { Verdict } from '@/types/evaluation'

interface VerdictBadgeProps {
  verdict: Verdict
  score: number
  className?: string
}

const VERDICT_STYLES: Record<Verdict, string> = {
  'Strong Apply': 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  Maybe: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  Skip: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
}

export function VerdictBadge({ verdict, score, className }: VerdictBadgeProps) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span
        className={cn(
          'inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold',
          VERDICT_STYLES[verdict]
        )}
      >
        {verdict}
      </span>
      <span className="text-2xl font-bold">{score}</span>
      <span className="text-xs text-muted-foreground">/100</span>
    </div>
  )
}
