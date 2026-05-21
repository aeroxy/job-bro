import { useCallback, useEffect, useRef } from 'react'

import { DEFAULT_EXPECTED_IO, chromeDownloadMonitor, tempToTopK, withChromeAiLock } from '@/lib/chrome-prompt-client'

// Chat tuning. Slightly warmer than evaluator default (0.3) since Q&A benefits
// from a bit of variation. topK derives from temperature via the same
// heuristic chatCompletionChrome uses.
const CHAT_TEMPERATURE = 0.4
import type { ChatTurn } from '@/types/chat'

interface CachedSession {
  session: ChromeAiSession
  systemPrompt: string
  // Snapshot of what we expect the caller's history to look like when the
  // NEXT askChrome arrives. Compared on entry — if either field disagrees
  // with the incoming history, we rebuild.
  //
  // Why both length AND the last answer's content?
  //  - length catches drops: caller appended fewer turns than we produced
  //    (stale-nonce filter in ReportChat, unmount before append, manual
  //    delete that races with completion, etc.).
  //  - lastAnswer catches silent replacement: caller appended a different
  //    assistant content than what session.prompt() returned (e.g. user
  //    edits, error sentinel, empty placeholder).
  //
  // The session itself committed `question` and `answer` internally, so
  // reusing it when the UI shows different turns would have the model
  // reasoning from a history the user can't see — confusing and wrong.
  // null on a freshly-created session means "no turns produced yet, only
  // the seeded history needs to match".
  expectedNextLength: number
  lastAnswer: string | null
}

function tailMatches(cached: CachedSession, history: ChatTurn[]): boolean {
  if (cached.expectedNextLength !== history.length) return false
  if (cached.lastAnswer === null) return true  // no turns produced through this session yet
  const last = history.at(-1)
  return last?.role === 'assistant' && last.content === cached.lastAnswer
}

// Stateful per-conversation Chrome AI session. The session is created lazily on
// the first ask and reused across turns — Chrome's API is inherently stateful,
// so we save the cost of re-sending the conversation each turn. The session is
// rebuilt automatically when the system prompt changes (new job, new analysis)
// or when the incoming history's tail diverges from what we expected — see
// `CachedSession` and `tailMatches`.
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
    if (typeof globalThis.ai?.languageModel === 'undefined') {
      throw new Error('Chrome built-in AI (Prompt API) is not available in this browser.')
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
          !tailMatches(cached, history)

        if (needsRebuild) {
          cached?.session.destroy()
          cacheRef.current = null  // clear before await so a failed create leaves no dangling reference
          const initialPrompts: ChromeAiPromptMessage[] = [{ role: 'system', content: systemPrompt }]
          for (const turn of history) {
            initialPrompts.push({ role: turn.role, content: turn.content })
          }
          if (!globalThis.ai?.languageModel) {
            throw new Error('Chrome built-in AI (Prompt API) is not available in this environment')
          }
          const session = await globalThis.ai.languageModel.create({
            initialPrompts,
            temperature: CHAT_TEMPERATURE,
            topK: tempToTopK(CHAT_TEMPERATURE),
            expectedInputs: DEFAULT_EXPECTED_IO,
            expectedOutputs: DEFAULT_EXPECTED_IO,
            monitor: chromeDownloadMonitor(),
          })
          cached = { session, systemPrompt, expectedNextLength: history.length, lastAnswer: null }
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

        // Record what we expect history to look like on the next call. The
        // length assumes the caller appends both turns (the standard contract);
        // lastAnswer lets us catch the case where they appended something
        // different (or nothing) without us knowing — tailMatches will reject
        // and force a rebuild on the next call.
        cached!.expectedNextLength = history.length + 2
        cached!.lastAnswer = answer
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
