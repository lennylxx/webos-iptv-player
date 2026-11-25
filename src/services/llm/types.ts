// How the endpoint is asked for JSON, best first; detected per endpoint and model.
export type StructuredMode = 'json_schema' | 'json_object' | 'prompt';

export type LlmPriority = 'foreground' | 'background';

// reasoning_effort values, least thinking first.
export type ReasoningEffort = 'none' | 'minimal' | 'low';

export type LlmFailureReason =
  | 'config'
  | 'disabled'
  | 'cap'
  | 'auth'
  // A spent quota or balance; waiting a moment won't help.
  | 'quota'
  // Throttled, and still throttled after the waits the server asked for.
  | 'rate'
  // The prompt didn't fit the model's context, or a per-request token cap.
  | 'context'
  // The server's content policy blocked the prompt or the reply.
  | 'blocked'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'http'
  | 'schema';

export interface LlmCapabilities {
  // baseUrl, model, and a hash of the API key the detection ran against.
  signature: string;
  structured: StructuredMode;
  // The least reasoning_effort the server took; '' sends none.
  effort: ReasoningEffort | '';
  // A LAN server took chat_template_kwargs, which turns a local model's thinking off.
  thinkingFields: boolean;
  // The server names the output budget max_completion_tokens.
  maxCompletionTokens: boolean;
  // The model's output cap as /models reports it; 0 when unknown.
  maxOutputTokens: number;
  checkedAt: number;
}

export interface LlmConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  // One "Name: value" per line, for gateways that need more than a bearer key.
  extraHeaders: string;
  // Prompt budget used to size batches; 0 until one is picked or detected, for the server's default.
  contextTokens: number;
  // The Context size Test connection last set from the server; 0 when none.
  detectedContextTokens: number;
  // 0 turns a cap off.
  dailyRequestCap: number;
  dailyTokenCap: number;
  features: Record<string, boolean>;
  capabilities: LlmCapabilities | null;
}

export type JsonSchema =
  | { type: 'object'; properties: Record<string, JsonSchema>; required: string[]; additionalProperties: false }
  | { type: 'array'; items: JsonSchema; maxItems?: number }
  | { type: 'string'; enum?: string[] }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' };

export interface NamedSchema {
  name: string;
  schema: JsonSchema;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
