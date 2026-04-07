import { useCallback, useState } from 'react'

import type { ExtractedJob } from '@/types/job'

export type ResumeStatus = 'idle' | 'generating' | 'done' | 'error'

export function useResumeGenerator() {
  const [status, setStatus] = useState<ResumeStatus>('idle')
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const _send = useCallback(async (payload: object) => {
    setStatus('generating')
    setError(null)

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GENERATE_RESUME', payload })

      if (response.type === 'RESUME_RESULT') {
        setMarkdown(response.payload.markdown)
        setSummary(response.payload.summary)
        setStatus('done')
      } else {
        setError(response.error || 'Resume generation failed')
        setStatus('error')
      }
    } catch (e) {
      setError((e as Error).message)
      setStatus('error')
    }
  }, [])

  const generate = useCallback((job: ExtractedJob, analysisContext?: string) => {
    setMarkdown(null)
    setSummary(null)
    return _send({ job, analysisContext })
  }, [_send])

  const regenerate = useCallback((job: ExtractedJob, comment: string) => {
    return _send({
      job,
      previousResume: markdown ?? undefined,
      previousSummary: summary ?? undefined,
      comment: comment.trim() || undefined,
    })
  }, [_send, markdown, summary])

  const reset = useCallback(() => {
    setStatus('idle')
    setMarkdown(null)
    setSummary(null)
    setError(null)
  }, [])

  return {
    status,
    markdown,
    error,
    generate,
    regenerate,
    setMarkdown,
    reset,
  }
}
