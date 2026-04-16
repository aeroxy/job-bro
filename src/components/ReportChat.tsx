import { MessageCircle, Send } from 'lucide-react'
import { marked } from 'marked'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

interface ReportChatProps {
  jobMarkdown: string
  analysisContext: string
}

export function ReportChat({ jobMarkdown, analysisContext }: ReportChatProps) {
  const [history, setHistory] = useState<ChatTurn[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (history.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [history.length])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const question = (new FormData(form).get('question') as string).trim()
    if (!question || loading) return
    form.reset()

    const newHistory: ChatTurn[] = [...history, { role: 'user', content: question }]
    setHistory(newHistory)
    setLoading(true)
    setError(null)

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CHAT_REQUEST',
        payload: {
          question,
          history,
          jobMarkdown,
          analysisContext,
        },
      })

      if (!mountedRef.current) return

      if (response.type === 'CHAT_RESPONSE') {
        setHistory([...newHistory, { role: 'assistant', content: response.payload.answer }])
      } else {
        setError(response.error || 'Something went wrong')
      }
    } catch (e) {
      if (!mountedRef.current) return
      setError((e as Error).message)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  return (
    <div className="border rounded-lg p-3 space-y-3">
      <h4 className="text-xs font-semibold flex items-center gap-1.5">
        <MessageCircle className="size-3 text-primary" />
        Ask about this analysis
      </h4>

      {history.length > 0 && (
        <div className="space-y-2">
          {history.map((turn, i) => (
            <div key={i}>
              {turn.role === 'user' ? (
                <div className="flex gap-1.5">
                  <span className="text-xs font-medium text-primary shrink-0">You:</span>
                  <p className="text-xs">{turn.content}</p>
                </div>
              ) : (
                <div
                  className="chat-response text-xs text-muted-foreground"
                  dangerouslySetInnerHTML={{ __html: marked.parse(turn.content, { async: false }) as string }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Thinking...
        </div>
      )}

      {error && (
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
