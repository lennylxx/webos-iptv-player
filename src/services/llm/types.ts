// How the endpoint is asked for JSON, best first; detected per endpoint and model.
export type StructuredMode = 'json_schema' | 'json_object' | 'prompt';

export type LlmPriority = 'foreground' | 'background';

export type LlmFailureReason =
  | 'config'
  | 'disabled'
  | 'cap'
  | 'auth'
  | 'quota'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'http'
  | 'schema';

export interface LlmCapabilities {
  // baseUrl + model the detection ran against.
  signature: string;
  structured: StructuredMode;
  // The endpoint accepted the request fields that turn a local model's thinking off.
  thinkingOff: boolean;
  // It also took reasoning_effort "none", the only switch Ollama's OpenAI API reads.
  effortOff: boolean;
  // The endpoint takes max_completion_tokens and no temperature (OpenAI reasoning models).
  reasoningParams: boolean;
  checkedAt: number;
}

export interface LlmConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  // One "Name: value" per line, for gateways that need more than a bearer key.
  extraHeaders: string;
  // Prompt budget used to size batches; small for local models.
  contextTokens: number;
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
