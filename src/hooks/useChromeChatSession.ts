import { useCallback, useEffect, useRef } from 'react'

import { DEFAULT_EXPECTED_IO, chromeDownloadMonitor, withChromeAiLock } from '@/lib/chrome-prompt-client'
import type { ChatTurn } from '@/types/chat'

interface CachedSession {
  session: ChromeAiSession
  systemPrompt: string
  // Number of conversation turns that this session "knows" (counts both user
  // and assistant entries). Compared against `history.length` on each ask to
  // decide whether to reuse or rebuild.
  knownLength: number
}

// Stateful per-conversation Chrome AI session. The session is created lazily on
// the first ask and reused across turns — Chrome's API is inherently stateful,
// so we save the cost of re-sending the conversation each turn. The session is
// rebuilt automatically when the system prompt changes (new job, new analysis)
// or when the history length doesn't match what the session has been told (e.g.
// after a retry that drops the last assistant turn).
//
// Concurrency: askChrome calls are serialized by a per-hook promise-chain lock
// so the cache-check / create / prompt critical section runs atomically. Without
// the lock, two interleaved calls can both decide to rebuild, both await
// LanguageModel.create(), and the second write to cacheRef orphans the first
// session (no destroy). The lock also prevents concurrent prompts on the same
// stateful session, which is unsupported.
export function useChromeChatSession() {
  const cacheRef = useRef<CachedSession | null>(null)
  const lockRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => () => {
    cacheRef.current?.session.destroy()
    cacheRef.current = null
  }, [])

  const askChrome = useCallback(async (
    systemPrompt: string,
    history: ChatTurn[],
    question: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    if (typeof globalThis.LanguageModel === 'undefined') {
      throw new Error('Chrome built-in AI is not available in this browser.')
    }

    // Take the lock: wait for any prior askChrome (success or failure) to
    // finish before entering the critical section, then publish our own
    // release-promise so the next caller waits for us.
    const waitFor = lockRef.current
    let release!: () => void
    lockRef.current = new Promise<void>((r) => { release = r })

    try {
      await waitFor
    } catch { /* prior call's failure is its own concern */ }

    // Honor an abort that fired while we were queued.
    if (signal?.aborted) {
      release()
      throw new DOMException('askChrome aborted before start', 'AbortError')
    }

    try {
      // Serialize against all other Chrome AI work in the app (e.g. evaluators
      // running concurrently). The per-hook lock above only orders calls
      // within this hook instance; withChromeAiLock is the global queue.
      return await withChromeAiLock(async () => {
        let cached = cacheRef.current
        const needsRebuild =
          !cached ||
          cached.systemPrompt !== systemPrompt ||
          cached.knownLength !== history.length

        if (needsRebuild) {
          cached?.session.destroy()
          cacheRef.current = null  // clear before await so a failed create leaves no dangling reference
          const initialPrompts: ChromeAiPromptMessage[] = [{ role: 'system', content: systemPrompt }]
          for (const turn of history) {
            initialPrompts.push({ role: turn.role, content: turn.content })
          }
          const session = await globalThis.LanguageModel.create({
            initialPrompts,
            temperature: 0.4,
            topK: 8,
            expectedInputs: DEFAULT_EXPECTED_IO,
            expectedOutputs: DEFAULT_EXPECTED_IO,
            monitor: chromeDownloadMonitor(),
          })
          cached = { session, systemPrompt, knownLength: history.length }
          cacheRef.current = cached
        }

        // Chrome's session.prompt() mutates internal state (commits the user
        // turn) before resolving. A throw or an empty response can leave the
        // session out of sync with our UI history — discard it in either case
        // so the next call rebuilds from clean state.
        let answer: string
        try {
          answer = await cached!.session.prompt(question, { signal })
        } catch (e) {
          cached!.session.destroy()
          if (cacheRef.current === cached) cacheRef.current = null
          throw e
        }

        if (!answer) {
          cached!.session.destroy()
          if (cacheRef.current === cached) cacheRef.current = null
          throw new Error('Chrome AI returned an empty response (likely a safety filter or internal error)')
        }

        cached!.knownLength += 2  // user question + the just-produced assistant answer
        return answer
      })
    } finally {
      release()
    }
  }, [])

  const reset = useCallback(() => {
    cacheRef.current?.session.destroy()
    cacheRef.current = null
  }, [])

  return { askChrome, reset }
}
