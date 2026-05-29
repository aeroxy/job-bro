import { cn } from '@/lib/utils'
import type { Verdict } from '@/types/evaluation'

type BadgeSize = 'default' | 'sm'

interface VerdictBadgeProps {
  verdict: Verdict
  score: number
  size?: BadgeSize
  className?: string
}

const VERDICT_STYLES: Record<Verdict, string> = {
  'Strong Apply': 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  Maybe: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  Skip: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
}

const SIZE_STYLES: Record<BadgeSize, { badge: string; score: string; label: string; gap: string }> = {
  default: {
    badge: 'px-3 py-1 text-sm',
    score: 'text-2xl',
    label: 'text-xs',
    gap: 'gap-3',
  },
  sm: {
    badge: 'px-1.5 py-0.5 text-[10px]',
    score: 'text-xs',
    label: 'text-[9px]',
    gap: 'gap-1.5',
  },
}

export function VerdictBadge({ verdict, score, size = 'default', className }: VerdictBadgeProps) {
  const styles = SIZE_STYLES[size]
  return (
    <div className={cn('flex items-center', styles.gap, className)}>
      <span
        className={cn(
          'inline-flex items-center rounded-full font-semibold',
          styles.badge,
          VERDICT_STYLES[verdict]
        )}
      >
        {verdict}
      </span>
      <span className={cn('font-bold', styles.score)}>{score}</span>
      <span className={cn('text-muted-foreground', styles.label)}>/100</span>
    </div>
  )
}
