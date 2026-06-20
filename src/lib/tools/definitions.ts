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

// Real research tools — the only definitions that have handlers in `handlers.ts`
// and produce tool results the model reads. `provide_verdict` (below) is NOT in
// this list: it's a structured-output channel, not a research tool.
export const ALL_TOOLS: ToolDefinition[] = [WEB_SEARCH_TOOL, READ_PAGE_TOOL]

// ============================================================================
// `provide_verdict` — in-house structured-output channel
// ============================================================================
//
// NOT a tool in the sense of `web_search` / `read_page`:
//   * it has no handler in `handlers.ts` and is never executed;
//   * no tool result is ever returned for the model to read;
//   * the agent loop intercepts the call and treats its arguments as the
//     final structured answer.
//
// It shares the *wire format* with tools (a function declaration under
// `body.tools`) because it's the only mechanism left when strict
// `response_format.json_schema` can't be used:
//   - strict json_schema is mutually exclusive with `tool_calls` on most
//     providers, so any evaluator that genuinely needs research tools can't
//     also use it;
//   - when `structured_output` is off, no schema enforcement exists at all.
//
// `buildVerdictSchema` wraps the evaluator's JSON schema as a fake tool
// declaration: the schema's `properties` become the tool's `parameters`, so
// "calling the tool" yields a JSON object of exactly the right shape. The
// agent loop terminates on this call — its `arguments` string becomes the
// returned content.
//
// Survives past `MAX_TOOL_ROUNDS` (research tools are stripped after 5
// rounds; this remains), with the nudge loop forcing the call while
// `tool_choice` stays `'auto'`. `MAX_AGENT_ITERATIONS` (10) bounds the loop.
export const VERDICT_NAME = 'provide_verdict'

export function buildVerdictSchema(schema: JsonSchemaSpec): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: VERDICT_NAME,
      description:
        'Submit your final structured verdict. You MUST call this to end your turn — the parameters ARE the verdict object. Do not write the answer as plain text.',
      parameters: schema.schema as unknown as ToolParameterSchema,
    },
  }
}
