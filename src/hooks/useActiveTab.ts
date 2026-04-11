import { useEffect, useRef, useState } from 'react'

export function useActiveTab() {
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const removedCallbacks = useRef(new Set<(tabId: number) => void>())

  useEffect(() => {
    // Get initial active tab
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) setActiveTabId(tab.id)
    })

    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
      setActiveTabId(info.tabId)
    }

    const onRemoved = (tabId: number) => {
      for (const cb of removedCallbacks.current) cb(tabId)
    }

    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onRemoved.addListener(onRemoved)

    return () => {
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
    }
  }, [])

  return { activeTabId, onTabRemoved: removedCallbacks.current }
}
