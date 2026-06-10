import { useCallback, useEffect, useRef, useState } from 'react'

export function useActiveTab() {
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const windowIdRef = useRef<number | null>(null)
  // Cached in-flight resolution of the sidepanel's window id. Reused by
  // getActiveTabId() and onActivated() so an activation event that arrives
  // before the initial getCurrent() resolves can still be matched against
  // the correct window instead of being silently dropped.
  const windowIdPromiseRef = useRef<Promise<number | null> | null>(null)
  const removedCallbacks = useRef(new Set<(tabId: number) => void>())

  const resolveWindowId = useCallback((): Promise<number | null> => {
    if (windowIdRef.current != null) return Promise.resolve(windowIdRef.current)
    if (!windowIdPromiseRef.current) {
      windowIdPromiseRef.current = chrome.windows.getCurrent({ windowTypes: ['normal', 'popup'] })
        .then((win) => {
          const id = win?.id ?? null
          if (id != null) windowIdRef.current = id
          return id
        })
        .catch(() => null)
    }
    return windowIdPromiseRef.current
  }, [])

  const getActiveTabId = useCallback(async (): Promise<number | null> => {
    const windowId = await resolveWindowId()
    if (windowId == null) return null
    const [tab] = await chrome.tabs.query({ active: true, windowId })
    return tab?.id ?? null
  }, [resolveWindowId])

  useEffect(() => {
    let mounted = true

    getActiveTabId().then((tabId) => {
      if (mounted && tabId != null) setActiveTabId(tabId)
    })

    // Don't drop activations that race the initial getCurrent() — resolve the
    // window id dynamically and verify against it. Locking onto info.windowId
    // unconditionally would risk picking the wrong window when the user
    // happens to interact with a sibling window first.
    const onActivated = async (info: chrome.tabs.TabActiveInfo) => {
      const myWindowId = await resolveWindowId()
      if (!mounted) return
      if (info.windowId !== myWindowId) return
      setActiveTabId(info.tabId)
    }

    const onRemoved = (tabId: number) => {
      for (const cb of removedCallbacks.current) cb(tabId)
    }

    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onRemoved.addListener(onRemoved)

    return () => {
      mounted = false
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
    }
  }, [getActiveTabId, resolveWindowId])

  return { activeTabId, getActiveTabId, onTabRemoved: removedCallbacks.current }
}
