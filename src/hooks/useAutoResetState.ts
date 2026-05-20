import { useState, useEffect } from 'react'

export function useAutoResetState<T>(initialValue: T, delay = 3000) {
  const [state, setState] = useState(initialValue)

  useEffect(() => {
    if (state === initialValue) return
    const timer = setTimeout(() => setState(initialValue), delay)
    return () => clearTimeout(timer)
  }, [state, initialValue, delay])

  return [state, setState] as const
}
