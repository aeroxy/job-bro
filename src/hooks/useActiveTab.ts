import { useCallback, useEffect, useRef, useState } from 'react'

export function useActiveTab() {
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const windowIdRef = useRef<number | null>(null)
  const removedCallbacks = useRef(new Set<(tabId: number) => void>())

  const getActiveTabId = useCallback(async (): Promise<number | null> => {
    const win = await chrome.windows.getCurrent({ windowTypes: ['normal', 'popup'] }).catch(() => null)
    const windowId = win?.id ?? null
    if (windowId == null) return null
    windowIdRef.current = windowId
    const [tab] = await chrome.tabs.query({ active: true, windowId })
    return tab?.id ?? null
  }, [])

  useEffect(() => {
    let mounted = true

    getActiveTabId().then((tabId) => {
      if (mounted && tabId != null) setActiveTabId(tabId)
    })

    const onActivated = async (info: chrome.tabs.TabActiveInfo) => {
      if (info.windowId !== windowIdRef.current) return
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
  }, [getActiveTabId])

  return { activeTabId, getActiveTabId, onTabRemoved: removedCallbacks.current }
}
