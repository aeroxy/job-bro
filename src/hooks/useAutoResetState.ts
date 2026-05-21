import { useState, useEffect } from 'react'

/**
 * State that automatically resets to `initialValue` after `delay` ms of inactivity.
 * Only works reliably with primitive initial values (string, number, boolean, null).
 * Objects/arrays use `===` equality and will always trigger the timer after a setState.
 */
export function useAutoResetState<T>(initialValue: T, delay = 3000) {
  const [state, setState] = useState(initialValue)

  useEffect(() => {
    if (state === initialValue) return
    const timer = setTimeout(() => setState(initialValue), delay)
    return () => clearTimeout(timer)
  }, [state, initialValue, delay])

  return [state, setState] as const
}
