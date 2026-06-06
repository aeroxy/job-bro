// Tool definitions exposed to the LLM. Keep descriptions concrete and short so
// the model picks the right tool.

import type { ToolDefinition } from './types'

export const GOOGLE_SEARCH_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'google_search',
    description:
      'Search Google and return the top results as markdown. Use this to find information about a company, role, salary range, or industry trend.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Use clear, specific keywords joined by spaces.',
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
      'Fetch a URL and return the page content as markdown (scripts, styles, and navigation chrome stripped). Use this to read an article, job posting, or company page.',
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

export const ALL_TOOLS: ToolDefinition[] = [GOOGLE_SEARCH_TOOL, READ_PAGE_TOOL]
