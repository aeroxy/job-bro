// Tool definitions exposed to the LLM. Keep descriptions concrete and short so
// the model picks the right tool.

import type { JsonSchemaSpec } from '@/lib/llm-client'
import type { ToolDefinition, ToolParameterSchema } from './types'

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

// The verdict tool is the structured-output mechanism for evaluators that
// can't use strict `response_format.json_schema` — i.e. any evaluator when
// structured_output is off, and tool-using evaluators always (strict
// json_schema blocks tool_calls). Its `parameters` ARE the evaluator's JSON
// schema, so calling the tool yields a JSON object of exactly the right
// shape. The agent loop treats this tool as terminal: when the model calls
// it, the loop ends and the call's arguments become the parsed result.
//
// This tool survives past MAX_TOOL_ROUNDS (research tools are stripped after
// 5 rounds, but provide_verdict remains, with the nudge loop forcing the call
// while keeping tool_choice set to 'auto'). The MAX_AGENT_ITERATIONS (10) ceiling still bounds the loop.
export const VERDICT_TOOL_NAME = 'provide_verdict'

export function buildVerdictTool(schema: JsonSchemaSpec): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: VERDICT_TOOL_NAME,
      description:
        'Submit your final structured verdict. You MUST call this tool to end your turn — the parameters ARE the verdict object. Do not write the answer as plain text.',
      parameters: schema.schema as unknown as ToolParameterSchema,
    },
  }
}
