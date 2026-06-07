// Tool handlers — must run in the service worker (fetch + manage offscreen).
// Each handler fetches the target URL, hands HTML to the offscreen document
// for DOM parsing + Turndown, and returns the resulting markdown. The parse
// pipeline lives in src/lib/html-to-markdown.ts.

import type { ToolHandlerContext } from './types'

const FETCH_TIMEOUT_MS = 20_000

async function parseViaOffscreen(html: string): Promise<string> {
  const res: { markdown?: string; trimmed?: boolean } = await chrome.runtime.sendMessage({
    type: 'PARSE_HTML',
    html,
  })
  if (!res?.markdown) throw new Error('Offscreen parser returned no result')
  if (res.markdown.startsWith('__PARSE_ERROR__:')) {
    throw new Error(res.markdown.slice('__PARSE_ERROR__:'.length))
  }
  return res.markdown
}

function fetchWithTimeout(
  url: string,
  signal?: AbortSignal,
  credentials: RequestCredentials = 'omit',
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Fetch timed out', 'TimeoutError')), FETCH_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  // Default to 'omit' so read_page — which the model can point at any URL,
  // including ones suggested by an injected job description — never sends the
  // user's cookies to arbitrary sites. Only the DuckDuckGo search path opts
  // into 'include' (see webSearch), where the bot-verification cookie matters.
  return fetch(url, { signal: combined, redirect: 'follow', credentials }).finally(() => clearTimeout(timer))
}

// DDG serves its anti-bot page with HTTP 200, so we detect it by content.
function isDdgBotChallenge(html: string): boolean {
  return html.includes('Unfortunately, bots use DuckDuckGo too')
}

// Open the DDG search URL in a tab so the user can clear the challenge. Reuse
// an existing html.duckduckgo.com tab instead of stacking new ones on retries.
async function openDdgChallengeTab(url: string): Promise<void> {
  const existing = await chrome.tabs.query({ url: 'https://html.duckduckgo.com/*' })
  const tabId = existing[0]?.id
  if (tabId != null) {
    await chrome.tabs.update(tabId, { active: true, url })
  } else {
    await chrome.tabs.create({ url, active: true })
  }
}

export async function webSearch(query: string, ctx: ToolHandlerContext = {}): Promise<string> {
  const q = encodeURIComponent(query.trim().replace(/\s+/g, ' '))
  // DuckDuckGo's HTML endpoint — no JS required, no rate-limit wall, and
  // not blocked by Google's bot detection (which would 429 us from a
  // service-worker fetch). Returns the same shape as the old Google path
  // once the offscreen parser turns the HTML into markdown.
  const url = `https://html.duckduckgo.com/html?q=${q}`
  // 'include' so the cookie a user earns by clearing DuckDuckGo's
  // bot-verification page is sent on the retry.
  const res = await fetchWithTimeout(url, ctx.signal, 'include')
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`)
  const html = await res.text()
  if (isDdgBotChallenge(html)) {
    await openDdgChallengeTab(url)
    throw new Error(
      'DuckDuckGo is showing a bot-verification page. A browser tab has been opened — ' +
        'ask the user to complete the verification there, then retry this search.'
    )
  }
  return cleanDdgRedirects(await parseViaOffscreen(html))
}

// DDG wraps every result href in a redirector: //duckduckgo.com/l/?uddg=<encoded
// target>&rut=…. We pull the real URL out of `uddg` so the model sees a clean,
// fetchable link instead of ~1.5KB of tracking blob per result. Organic results
// decode straight to the target; ad results decode to a duckduckgo.com/y.js
// redirect (real target double-encoded in `u3`) — we drop those.
function cleanDdgRedirects(md: string): string {
  return md.replace(/(?:https?:)?\/\/duckduckgo\.com\/l\/\?[^\s)]+/g, (match) => {
    try {
      // Protocol-relative hrefs (`//duckduckgo.com/...`) need a scheme prepended;
      // absolute ones (`https://...`) must not, or we'd get `https:https://…`.
      const urlString = match.startsWith('//') ? 'https:' + match : match
      const target = new URL(urlString).searchParams.get('uddg')
      if (!target) return match
      const targetUrl = new URL(target)
      // Ad redirect: duckduckgo.com/y.js with the real target double-encoded
      // in `u3`. Match on host+path so legit URLs that merely contain "/y.js"
      // (e.g. a repo/CDN path) aren't mistaken for ads and dropped.
      if (targetUrl.hostname.endsWith('duckduckgo.com') && targetUrl.pathname === '/y.js') {
        return targetUrl.searchParams.get('u3') ?? ''
      }
      return target
    } catch {
      return match
    }
  })
}

// we do not restrict the tool from fetching localhost or private IP addresses
// because in custom system prompt user can refer to local resources
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
  return parseViaOffscreen(html)
}
