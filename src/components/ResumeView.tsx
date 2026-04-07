import { ArrowLeft, Download, FileText, Printer, RefreshCw } from 'lucide-react'
import { useMemo } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { marked } from 'marked'

import type { ExtractedJob } from '@/types/job'
import type { ResumeStatus } from '@/hooks/useResumeGenerator'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { downloadMarkdown, downloadPDF, makeFilename } from '@/lib/download'

interface ResumeViewProps {
  job: ExtractedJob
  markdown: string | null
  status: ResumeStatus
  error: string | null
  onMarkdownChange: (md: string) => void
  onRegenerate: (comment: string) => void
  onBack: () => void
}

export function ResumeView({
  job,
  markdown,
  status,
  error,
  onMarkdownChange,
  onRegenerate,
  onBack,
}: ResumeViewProps) {
  const html = useMemo(() => {
    if (!markdown) return ''
    return marked.parse(markdown, { async: false }) as string
  }, [markdown])

  const isGenerating = status === 'generating'

  const handleDownloadMd = () => {
    if (!markdown) return
    downloadMarkdown(markdown, makeFilename(job.company, job.title, 'md'))
  }

  const handleDownloadPdf = () => {
    if (!html) return
    downloadPDF(html, makeFilename(job.company, job.title, 'pdf'))
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="cursor-pointer">
          <ArrowLeft className="size-3.5" />
        </Button>
        <FileText className="size-4 text-primary" />
        <span className="text-sm font-medium">Resume</span>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Generating state — shown instead of resume content */}
        {isGenerating && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-2">
              <Spinner className="size-6 mx-auto" />
              <p className="text-xs text-muted-foreground">Generating tailored resume...</p>
            </div>
          </div>
        )}

        {/* Error */}
        {!isGenerating && error && (
          <div className="mx-3 mt-3 border border-destructive/50 rounded-lg p-3 bg-destructive/5">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {/* Resume content — hidden while generating */}
        {!isGenerating && markdown && (
          <Tabs.Root defaultValue="preview" className="flex-1 flex flex-col overflow-hidden">
            <Tabs.List className="flex border-b px-3">
              <Tabs.Trigger
                value="preview"
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary cursor-pointer"
              >
                Preview
              </Tabs.Trigger>
              <Tabs.Trigger
                value="edit"
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary cursor-pointer"
              >
                Edit
              </Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="preview" className="flex-1 overflow-y-auto p-3">
              <div
                className="resume-preview text-xs text-foreground"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </Tabs.Content>

            <Tabs.Content value="edit" className="flex-1 overflow-hidden p-3">
              <textarea
                value={markdown}
                onChange={(e) => onMarkdownChange(e.target.value)}
                className="w-full h-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </Tabs.Content>
          </Tabs.Root>
        )}
      </div>

      {/* Feedback + actions footer */}
      {!isGenerating && (markdown || error) && (
        <footer className="border-t p-3 space-y-2">
          {/* Feedback form — unmounts during generation, so no manual reset needed */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const comment = new FormData(e.currentTarget).get('comment') as string
              e.currentTarget.reset()
              onRegenerate(comment)
            }}
            className="flex gap-2 items-end"
          >
            <textarea
              name="comment"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  e.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder="Describe changes to improve the resume... (⌘↵ to send)"
              rows={2}
              className="flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="cursor-pointer shrink-0 self-stretch"
            >
              <RefreshCw className="size-3" />
            </Button>
          </form>

          {/* Download row */}
          {markdown && (
            <div className="flex gap-2">
              <Button
                onClick={handleDownloadMd}
                variant="outline"
                size="sm"
                className="flex-1 cursor-pointer"
              >
                <Download className="size-3" />
                .md
              </Button>
              <Button
                onClick={handleDownloadPdf}
                size="sm"
                className="flex-1 cursor-pointer"
              >
                <Printer className="size-3" />
                .pdf
              </Button>
            </div>
          )}
        </footer>
      )}
    </div>
  )
}
