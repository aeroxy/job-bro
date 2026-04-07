export function downloadMarkdown(markdown: string, filename: string) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadPDF(html: string, title: string) {
  const win = window.open('', '_blank')
  if (!win) return

  win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body {
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    max-width: 800px;
    margin: 40px auto;
    padding: 0 20px;
    color: #1a1a1a;
    line-height: 1.6;
    font-size: 14px;
  }
  h1 { font-size: 1.8em; margin-bottom: 0.2em; border-bottom: 2px solid #333; padding-bottom: 0.3em; }
  h2 { font-size: 1.3em; margin-top: 1.2em; margin-bottom: 0.4em; color: #2a2a2a; border-bottom: 1px solid #ddd; padding-bottom: 0.2em; }
  h3 { font-size: 1.1em; margin-top: 0.8em; margin-bottom: 0.3em; }
  p { margin: 0.4em 0; }
  ul, ol { margin: 0.4em 0; padding-left: 1.5em; }
  li { margin: 0.2em 0; }
  strong { font-weight: 600; }
  hr { border: none; border-top: 1px solid #ddd; margin: 1em 0; }
  @media print {
    body { margin: 0; padding: 0; }
  }
</style>
</head>
<body>${html}</body>
</html>`)
  win.document.close()
  win.addEventListener('afterprint', () => win.close())
  // Small delay to ensure content is rendered before printing
  setTimeout(() => win.print(), 300)
}

export function makeFilename(company: string, title: string, ext: string): string {
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
  return `Resume_${sanitize(company)}_${sanitize(title)}.${ext}`
}
