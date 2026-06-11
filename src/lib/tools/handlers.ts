// Tool handlers — run in whichever context owns the analysis orchestration.
// In the service worker they message the offscreen for PARSE_HTML; in the
// offscreen they call parseHtmlToMarkdown directly (no round-trip needed).
// Each handler fetches the target URL, parses to markdown, and returns the
// result. The parse pipeline lives in src/lib/html-to-markdown.ts.

import { parseHtmlToMarkdown } from '@/lib/html-to-markdown'
import type { ToolHandlerContext } from './types'

const FETCH_TIMEOUT_MS = 20_000

// Detect whether we're running inside the offscreen document. The offscreen
// has DOMParser available and can parse HTML directly; the service worker
// routes through the offscreen via PARSE_HTML messages.
const IS_OFFSCREEN = typeof DOMParser !== 'undefined'

async function parseViaOffscreen(html: string): Promise<string> {
  if (IS_OFFSCREEN) {
    return parseHtmlToMarkdown(html).markdown
  }
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
  // credentials defaults to 'omit' (secure default for any future caller), but
  // both current callers opt into 'include': webSearch for DuckDuckGo's bot-
  // verification cookie, and read_page so it can act as the user against their
  // own authenticated sessions (see read_page's comment for the tradeoff).
  return fetch(url, { signal: combined, redirect: 'follow', credentials }).finally(() => clearTimeout(timer))
}

// DDG serves its anti-bot page with HTTP 200, so we detect it by content.
function isDdgBotChallenge(html: string): boolean {
  return html.includes('Unfortunately, bots use DuckDuckGo too')
}

// Open the DDG search URL in a tab so the user can clear the challenge. Reuse
// an existing html.duckduckgo.com tab instead of stacking new ones on retries.
// Falls back to messaging the background when chrome.tabs is unavailable
// (e.g. running inside the offscreen document).
async function openDdgChallengeTab(url: string): Promise<void> {
  if (typeof chrome.tabs?.query === 'function') {
    try {
      const existing = await chrome.tabs.query({ url: 'https://html.duckduckgo.com/*' })
      const tabId = existing[0]?.id
      if (tabId != null) {
        await chrome.tabs.update(tabId, { active: true, url })
        return
      }
    } catch (e) {
      console.warn('[Job Bro] Failed to query/update existing tab:', e)
    }
    try {
      await chrome.tabs.create({ url, active: true })
      return
    } catch (e) {
      console.warn('[Job Bro] Failed to create tab directly:', e)
    }
  }
  chrome.runtime.sendMessage({ type: 'OPEN_DDGC_CHALLENGE_TAB', url }).catch(() => {})
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

// Two deliberate choices, both trading a little safety for usefulness:
//   1. credentials: 'include' — read_page fetches with the user's cookies so it
//      acts AS the user: it can read pages behind their own authenticated
//      sessions (intranets, logged-in job boards, local services that need
//      auth). Sending the user's own credentials to read the user's own
//      resources is the whole point of the tool.
//   2. No localhost / private-IP blocking. The textbook SSRF guard barely
//      applies: the fetch runs in the user's own service worker on their own
//      machine, so it can only reach what the user can already reach — no
//      privilege boundary is crossed.
// Residual risk: a prompt-injected JD steers the LLM to read something
// sensitive (now including credentialed/local resources) and exfiltrate via a
// later tool call. We accept it — it needs the user to analyze attacker
// content, it's blind (the JD author has no idea what hosts/ports/paths exist
// on the victim's machine or which sessions they're logged into, so any
// injected target is a guess into the void), and an IP blocklist wouldn't close
// it anyway since outbound public fetches stay open by design. Vanishingly
// unlikely for a LinkedIn job poster.
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
  const res = await fetchWithTimeout(parsed.toString(), ctx.signal, 'include')
  if (!res.ok) throw new Error(`Fetch returned HTTP ${res.status}`)
  const html = await res.text()
  return parseViaOffscreen(html)
}
