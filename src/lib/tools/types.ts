// Tool-calling protocol types — OpenAI-compatible.

export interface ToolFunctionParameter {
  type: 'string' | 'number' | 'boolean'
  description: string
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, ToolFunctionParameter>
      required: string[]
    }
  }
}

export interface ToolCallFunction {
  name: string
  arguments: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: ToolCallFunction
}

export interface ChatCompletionWithToolsResult {
  content: string
  tool_calls?: ToolCall[]
}

export interface ToolHandlerContext {
  signal?: AbortSignal
}
