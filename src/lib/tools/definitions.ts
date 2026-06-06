// Tool definitions exposed to the LLM. Keep descriptions concrete and short so
// the model picks the right tool.

import type { ToolDefinition } from './types'

export const WEB_SEARCH_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web (via DuckDuckGo HTML) and return the results page as markdown. Use this to find information about a company, role, salary range, or industry trend.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — a normal phrase or space-separated keywords. The handler URL-encodes it for you; do not add "+" between words.',
        },
      },
      required: ['query'],
    },
  },
}

export const READ_PAGE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_page',
    description:
      'Fetch a URL and return the page content as markdown (scripts and styles stripped). Use this to read an article, job posting, or company page.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute URL to fetch, e.g. https://example.com/jobs/123',
        },
      },
      required: ['url'],
    },
  },
}

export const ALL_TOOLS: ToolDefinition[] = [WEB_SEARCH_TOOL, READ_PAGE_TOOL]
