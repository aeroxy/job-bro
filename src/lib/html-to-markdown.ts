// Shared HTML → markdown pipeline used by the offscreen document (which
// services the agent tools). Pure functions over DOMParser + Turndown —
// no chrome.* APIs here, so it runs in any context with a window/DOMParser.

import TurndownService from 'turndown'

// Drop non-content elements: scripts/styles plus interactive chrome
// (forms, nav, footers, search boxes, dropdowns). These are never the
// content we want as markdown — on DuckDuckGo's results page this strips
// the header search form, region/time-filter <select>s, and the pagination
// form; on arbitrary read_page targets it strips nav bars and footers.
// <header> is left intact so article titles (often an <h1> inside it) survive.
function stripNonContent(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc
    .querySelectorAll('script, style, link, meta, noscript, form, nav, footer, aside, select, button')
    .forEach((el) => el.remove())
  // Turndown only the body so the <title> ("… at DuckDuckGo") doesn't leak in.
  return doc.body?.innerHTML ?? doc.documentElement.outerHTML
}

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  return td.turndown(html)
}

// Strip non-content elements and convert the whole cleaned HTML to markdown.
// Used for both web_search (DuckDuckGo HTML results) and read_page — no
// anchor-based trimming; the model gets the whole page and picks what
// it needs.
export function parseHtmlToMarkdown(html: string): { markdown: string; trimmed: boolean } {
  const cleaned = stripNonContent(html)
  return { markdown: htmlToMarkdown(cleaned), trimmed: false }
}
