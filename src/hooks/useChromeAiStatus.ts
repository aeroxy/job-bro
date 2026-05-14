import { useCallback, useEffect, useState } from 'react'

import {
  ensureChromeAiDownloaded,
  getChromeAiAvailability,
  onChromeDownloadProgress,
} from '@/lib/chrome-prompt-client'

export interface ChromeAiStatusState {
  status: ChromeAiAvailability
  // 0..1 fraction emitted by Chrome during 'downloading'; undefined otherwise
  downloadProgress?: number
}

export function useChromeAiStatus() {
  const [state, setState] = useState<ChromeAiStatusState>({ status: 'unavailable' })

  const refresh = useCallback(async () => {
    const status = await getChromeAiAvailability()
    setState((prev) => {
      if (prev.status === status) return prev
      return status === 'downloading'
        ? { status, downloadProgress: prev.downloadProgress }
        : { status }
    })
  }, [])

  useEffect(() => {
    refresh()
    // Subscribe to download-progress events broadcast from chrome-prompt-client.
    // Any session creation in the app forwards events here.
    const unsub = onChromeDownloadProgress((loaded) => {
      setState((prev) => {
        if (prev.status === 'available' && loaded < 1) {
          // Stale event after we already marked available; ignore.
          return prev
        }
        if (loaded >= 1) {
          return { status: 'available', downloadProgress: 1 }
        }
        return { status: 'downloading', downloadProgress: loaded }
      })
    })
    return unsub
  }, [refresh])

  const startDownload = useCallback(async () => {
    setState({ status: 'downloading', downloadProgress: 0 })
    try {
      await ensureChromeAiDownloaded()
      setState({ status: 'available', downloadProgress: 1 })
    } catch (e) {
      // Surface the failure by re-querying — likely flips back to 'downloadable' or 'unavailable'.
      console.error('[chrome-ai] download failed', e)
      await refresh()
    }
  }, [refresh])

  return {
    status: state.status,
    downloadProgress: state.downloadProgress,
    refresh,
    startDownload,
  }
}
