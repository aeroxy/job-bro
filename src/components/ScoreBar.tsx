import { cn } from '@/lib/utils'

interface ScoreBarProps {
  label: string
  value: number // 0-1
  className?: string
}

function getBarColor(value: number): string {
  if (value >= 0.7) return 'bg-green-500'
  if (value >= 0.4) return 'bg-yellow-500'
  return 'bg-red-500'
}

export function ScoreBar({ label, value, className }: ScoreBarProps) {
  const percentage = Math.round(value * 100)

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{percentage}%</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-500', getBarColor(value))}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  )
}
