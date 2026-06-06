// Tool handlers — must run in the service worker (fetch + manage offscreen).
// Each handler fetches the target URL, hands HTML to the offscreen document
// for DOM parsing + Turndown, and returns the resulting markdown. The parse
// pipeline lives in src/lib/html-to-markdown.ts and is shared with the dev
// test page so the google_search tool's output matches what the test page
// produces byte-for-byte.

import type { ToolHandlerContext } from './types'

const FETCH_TIMEOUT_MS = 20_000

async function parseViaOffscreen(
  html: string,
  mode: 'google_search' | 'read_page'
): Promise<string> {
  const res: { markdown?: string; trimmed?: boolean } = await chrome.runtime.sendMessage({
    type: 'PARSE_HTML',
    html,
    mode,
  })
  if (!res?.markdown) throw new Error('Offscreen parser returned no result')
  if (res.markdown.startsWith('__PARSE_ERROR__:')) {
    throw new Error(res.markdown.slice('__PARSE_ERROR__:'.length))
  }
  return res.markdown
}

function fetchWithTimeout(url: string, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Fetch timed out', 'TimeoutError')), FETCH_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  return fetch(url, { signal: combined, redirect: 'follow' }).finally(() => clearTimeout(timer))
}

export async function googleSearch(query: string, ctx: ToolHandlerContext = {}): Promise<string> {
  const q = encodeURIComponent(query.trim().replace(/\s+/g, ' '))
  const url = `https://www.google.com/search?q=${q}&num=10`
  const res = await fetchWithTimeout(url, ctx.signal)
  if (!res.ok) throw new Error(`Google returned HTTP ${res.status}`)
  const html = await res.text()
  return parseViaOffscreen(html, 'google_search')
}

export async function readPage(url: string, ctx: ToolHandlerContext = {}): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`)
  }
  const res = await fetchWithTimeout(parsed.toString(), ctx.signal)
  if (!res.ok) throw new Error(`Fetch returned HTTP ${res.status}`)
  const html = await res.text()
  return parseViaOffscreen(html, 'read_page')
}
