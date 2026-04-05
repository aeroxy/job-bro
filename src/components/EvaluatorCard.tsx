import * as Collapsible from '@radix-ui/react-collapsible'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'

interface EvaluatorCardProps {
  title: string
  icon: React.ReactNode
  status: 'pending' | 'running' | 'completed' | 'error'
  error?: string
  children: React.ReactNode
  className?: string
}

export function EvaluatorCard({
  title,
  icon,
  status,
  error,
  children,
  className,
}: EvaluatorCardProps) {
  const [open, setOpen] = useState(false)

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className={cn('border rounded-lg', className)}>
        <Collapsible.Trigger className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/50 transition-colors cursor-pointer">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{icon}</span>
            <span className="text-xs font-medium">{title}</span>
          </div>
          <div className="flex items-center gap-2">
            <StatusIndicator status={status} />
            <ChevronDown
              className={cn(
                'size-3 text-muted-foreground transition-transform',
                open && 'rotate-180'
              )}
            />
          </div>
        </Collapsible.Trigger>

        <Collapsible.Content>
          <div className="px-3 pb-3 pt-1 border-t">
            {status === 'error' && error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
            {status === 'completed' && children}
          </div>
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  )
}

function StatusIndicator({ status }: { status: string }) {
  if (status === 'running') {
    return (
      <span className="flex size-2">
        <span className="animate-ping absolute inline-flex size-2 rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-blue-500" />
      </span>
    )
  }
  if (status === 'completed') {
    return <span className="inline-flex size-2 rounded-full bg-green-500" />
  }
  if (status === 'error') {
    return <span className="inline-flex size-2 rounded-full bg-red-500" />
  }
  return <span className="inline-flex size-2 rounded-full bg-muted-foreground/30" />
}
