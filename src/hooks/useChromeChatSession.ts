import { useCallback, useEffect, useRef } from 'react'

import {
  createChromeAiSession,
  destroyChromeAiSession,
  promptChromeAiSession,
} from '@/lib/chrome-ai-client'
import type { ChatTurn } from '@/types/chat'

// Chat tuning. Slightly warmer than evaluator default (0.3) since Q&A benefits
// from a bit of variation. topK derives from temperature inside the offscreen.
const CHAT_TEMPERATURE = 0.4

interface CachedSession {
  sessionId: string
  systemPrompt: string
  // Snapshot of what we expect the caller's history to look like when the
  // NEXT askChrome arrives. Compared on entry — if either field disagrees
  // with the incoming history, we rebuild.
  expectedNextLength: number
  lastAnswer: string | null
}

function tailMatches(cached: CachedSession, history: ChatTurn[]): boolean {
  if (cached.expectedNextLength !== history.length) return false
  if (cached.lastAnswer === null) return true
  const last = history.at(-1)
  return last?.role === 'assistant' && last.content === cached.lastAnswer
}

// Stateful per-conversation Chrome AI session. The session lives in the
// offscreen document (the only context with LanguageModel API access); this
// hook holds a session ID and the cached metadata needed to decide when to
// rebuild it.
//
// The offscreen serializes all Chrome AI work through a single FIFO, so no
// app-wide lock is needed. We still keep a per-hook lock around the
// cacheRef check/create/destroy critical section — two interleaved calls
// could otherwise both decide to rebuild, both kick off a create, and the
// second call would orphan the first session without destroying it.
export function useChromeChatSession() {
  const cacheRef = useRef<CachedSession | null>(null)
  const lockRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => () => {
    const cached = cacheRef.current
    cacheRef.current = null
    if (cached) {
      destroyChromeAiSession(cached.sessionId).catch(() => { /* offscreen may be gone */ })
    }
  }, [])

  const askChrome = useCallback(async (
    systemPrompt: string,
    history: ChatTurn[],
    question: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    // Take the per-hook lock.
    const waitFor = lockRef.current
    let release!: () => void
    lockRef.current = new Promise<void>((r) => { release = r })

    try {
      await waitFor
    } catch { /* prior call's failure is its own concern */ }

    if (signal?.aborted) {
      release()
      throw new DOMException('askChrome aborted before start', 'AbortError')
    }

    try {
      let cached = cacheRef.current
      const needsRebuild =
        !cached ||
        cached.systemPrompt !== systemPrompt ||
        !tailMatches(cached, history)

      if (needsRebuild) {
        if (cached) {
          destroyChromeAiSession(cached.sessionId).catch(() => { /* offscreen may be gone */ })
          cacheRef.current = null
        }
        const sessionId = await createChromeAiSession({
          systemPrompt,
          history,
          temperature: CHAT_TEMPERATURE,
        })
        cached = { sessionId, systemPrompt, expectedNextLength: history.length, lastAnswer: null }
        cacheRef.current = cached
      }

      // session.prompt() commits the user turn before resolving. A throw
      // would leave the offscreen session out of sync with our UI history —
      // destroy it so the next call rebuilds from clean state.
      let answer: string
      try {
        answer = await promptChromeAiSession(cached!.sessionId, question, { signal })
      } catch (e) {
        destroyChromeAiSession(cached!.sessionId).catch(() => {})
        if (cacheRef.current === cached) cacheRef.current = null
        throw e
      }

      if (!answer) {
        destroyChromeAiSession(cached!.sessionId).catch(() => {})
        if (cacheRef.current === cached) cacheRef.current = null
        throw new Error('Chrome AI returned an empty response (likely a safety filter or internal error)')
      }

      cached!.expectedNextLength = history.length + 2
      cached!.lastAnswer = answer
      return answer
    } finally {
      release()
    }
  }, [])

  const reset = useCallback(() => {
    const cached = cacheRef.current
    cacheRef.current = null
    if (cached) {
      destroyChromeAiSession(cached.sessionId).catch(() => { /* offscreen may be gone */ })
    }
  }, [])

  return { askChrome, reset }
}
