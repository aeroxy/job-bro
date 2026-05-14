import { MessageCircle, Send, Trash2 } from 'lucide-react'
import { marked } from 'marked'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useChromeChatSession } from '@/hooks/useChromeChatSession'
import { buildChromeChatSystemPrompt } from '@/lib/llm-handlers'
import type { ChatTurn } from '@/types/chat'
import type { UserProfile } from '@/types/profile'

interface ReportChatProps {
  jobMarkdown: string
  analysisContext: string
  history: ChatTurn[]
  loading: boolean
  currentTabId: number
  // When set, dispatch chat directly to Chrome's built-in AI in this window
  // instead of routing through the background service worker.
  useChromeBackend?: boolean
  profile?: UserProfile
  customPrompt?: string
  onAppend: (turns: ChatTurn[], targetTabId: number, nonce?: number) => void
  onSetLoading: (tabId: number, loading: boolean, nonce?: number) => void
  onBumpNonce: (tabId: number) => number
  onDeleteTurn: (index: number) => void
}

export function ReportChat({
  jobMarkdown,
  analysisContext,
  history,
  loading,
  currentTabId,
  useChromeBackend,
  profile,
  customPrompt,
  onAppend,
  onSetLoading,
  onBumpNonce,
  onDeleteTurn,
}: ReportChatProps) {
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const prevLengthRef = useRef(history.length)
  const { askChrome } = useChromeChatSession()

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (history.length > prevLengthRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    prevLengthRef.current = history.length
  }, [history.length])

  // nonce is bumped by the caller before invoking; stale completions are dropped via nonce checks
  async function sendQuestion(question: string, historyContext: ChatTurn[], tabId: number, nonce: number) {
    setError(null)
    try {
      if (useChromeBackend && profile) {
        // In-window dispatch via persistent Chrome AI session.
        const systemPrompt = buildChromeChatSystemPrompt(customPrompt, profile, jobMarkdown, analysisContext)
        const answer = await askChrome(systemPrompt, historyContext, question)
        onAppend([{ role: 'assistant', content: answer }], tabId, nonce)
      } else {
        const response = await chrome.runtime.sendMessage({
          type: 'CHAT_REQUEST',
          payload: { question, history: historyContext, jobMarkdown, analysisContext },
        })
        if (response.type === 'CHAT_RESPONSE') {
          onAppend([{ role: 'assistant', content: response.payload.answer }], tabId, nonce)
        } else if (mountedRef.current) {
          setError(response.error || 'Something went wrong')
        }
      }
    } catch (e) {
      if (mountedRef.current) setError((e as Error).message)
    } finally {
      onSetLoading(tabId, false, nonce)
    }
  }

  async function handleRetry() {
    if (loading || retrying) return
    const lastUserTurn = history.at(-1)
    if (!lastUserTurn || lastUserTurn.role !== 'user') return
    const tabId = currentTabId
    setRetrying(true)
    const nonce = onBumpNonce(tabId)
    onSetLoading(tabId, true)
    try {
      await sendQuestion(lastUserTurn.content, history.slice(0, -1), tabId, nonce)
    } finally {
      setRetrying(false)
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const question = (new FormData(form).get('question') as string).trim()
    if (!question || loading) return
    form.reset()
    setPendingDelete(null)

    // Capture the tab this question belongs to — activeTabId may change before the response lands
    const tabId = currentTabId

    // Bump nonce and set loading before appending the user turn — all land in the same render batch.
    // User turns are not nonce-guarded (always append); only the assistant response and loading=false are.
    const nonce = onBumpNonce(tabId)
    onSetLoading(tabId, true)
    onAppend([{ role: 'user', content: question }], tabId)
    await sendQuestion(question, history, tabId, nonce)
  }

  return (
    <div className="border rounded-lg p-3 space-y-3">
      <h4 className="text-xs font-semibold flex items-center gap-1.5">
        <MessageCircle className="size-3 text-primary" />
        Ask about this analysis
      </h4>

      {history.length > 0 && (
        <div className="space-y-0">
          {history.map((turn, i) => (
            <div key={i} className={`group relative${turn.role === 'user' && i > 0 ? ' border-t border-border pt-3 mt-1' : ''} ${turn.role === 'assistant' ? 'pt-1.5 pb-2' : 'pb-0'}`}>
              {turn.role === 'user' ? (
                <div className="flex gap-1.5 items-start">
                  <span className="text-xs font-medium text-primary shrink-0">You:</span>
                  <p className="text-xs flex-1">{turn.content}</p>
                </div>
              ) : (
                <div
                  className="chat-response text-xs text-muted-foreground"
                  dangerouslySetInnerHTML={{ __html: marked.parse(turn.content, { async: false }) as string }}
                />
              )}
              {pendingDelete === i ? (
                <div className="absolute -right-1 top-2 flex items-center gap-1">
                  <span className="text-[10px] text-destructive">delete?</span>
                  <button
                    onClick={() => { onDeleteTurn(i); setPendingDelete(null) }}
                    className="p-0.5 rounded text-destructive cursor-pointer"
                    title="Confirm delete"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setPendingDelete(i)}
                  className="absolute -right-1 top-2 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-muted-foreground hover:text-destructive cursor-pointer"
                  title="Remove turn"
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {(loading || retrying) && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Thinking...
        </div>
      )}

      {!loading && !retrying && history.at(-1)?.role === 'user' && (
        <div className="flex items-center gap-2">
          {error && <p className="text-xs text-destructive flex-1">{error}</p>}
          <button
            onClick={handleRetry}
            className="text-xs text-muted-foreground hover:text-foreground underline cursor-pointer shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {error && history.at(-1)?.role !== 'user' && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      <div ref={bottomRef} />

      <form onSubmit={handleSubmit} className="flex gap-2 items-end">
        <textarea
          name="question"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder="Ask a follow-up question... (⌘↵ to send)"
          rows={2}
          disabled={loading}
          className="flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={loading}
          className="cursor-pointer shrink-0 self-stretch"
        >
          <Send className="size-3" />
        </Button>
      </form>
    </div>
  )
}
