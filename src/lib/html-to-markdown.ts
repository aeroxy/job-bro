// Shared HTML → markdown pipeline used by both the dev test page and the
// offscreen document (which services the agent tools). Pure functions over
// DOMParser + Turndown — no chrome.* APIs here, so it runs in any context
// with a window/DOMParser.

import TurndownService from 'turndown'

const ANCHOR_TEXT = 'Search Results'

function stripScriptsAndStyles(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style, link[rel="stylesheet"], noscript').forEach((el) => el.remove())
  return doc.documentElement.outerHTML
}

// Find the first <h1> whose text equals anchorText and return a fragment
// spanning from that h1 to the end of its containing body. Captures the h1
// itself plus every following sibling, naturally splitting ancestor
// boundaries at the h1.
function trimToAnchor(html: string, anchorText: string): { html: string; found: boolean } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const anchor = Array.from(doc.querySelectorAll('h1')).find(
    (el) => el.textContent?.trim() === anchorText
  )
  if (!anchor) return { html, found: false }
  const root = anchor.closest('body') ?? doc.documentElement
  const range = doc.createRange()
  range.setStartBefore(anchor)
  range.setEndAfter(root.lastChild ?? anchor)
  const fragment = range.cloneContents()
  const wrap = doc.createElement('div')
  wrap.appendChild(fragment)
  return { html: wrap.innerHTML, found: true }
}

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  return td.turndown(html)
}

// Google search results page: strip <script>/<style>, trim to the first
// <h1>Search Results</h1> and everything after, then convert to markdown.
// If the anchor isn't found, falls back to the full cleaned HTML.
export function parseGoogleSearchResults(html: string): { markdown: string; trimmed: boolean } {
  const cleaned = stripScriptsAndStyles(html)
  const { html: trimmed, found } = trimToAnchor(cleaned, ANCHOR_TEXT)
  return { markdown: htmlToMarkdown(trimmed), trimmed: found }
}

// Generic page: strip <script>/<style> and convert the whole cleaned HTML
// to markdown. Used for the read_page tool.
export function parseGenericPage(html: string): { markdown: string; trimmed: boolean } {
  const cleaned = stripScriptsAndStyles(html)
  return { markdown: htmlToMarkdown(cleaned), trimmed: false }
}
