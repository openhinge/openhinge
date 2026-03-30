export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  [key: string]: unknown;
}

export interface ToolDefinition {
  type?: string;  // 'function' (OpenAI), 'custom' (Anthropic), or server tool types
  function?: { name: string; description?: string; parameters?: JsonSchema };
  // Anthropic format
  name?: string;
  description?: string;
  input_schema?: JsonSchema;
  [key: string]: unknown;  // Allow pass-through of extra fields (cache_control, allowed_callers, etc.)
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string[];
  response_schema?: JsonSchema;
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  top_p?: number;
  top_k?: number;
  metadata?: { user_id?: string };
  thinking?: { type: string; budget_tokens?: number; display?: string };
  // OpenAI-specific params (passed through to OpenAI provider)
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  user?: string;
  // Anthropic-specific params (passed through to Claude provider)
  service_tier?: string;
}

export interface FallbackAttempt {
  provider_id: string;
  provider_name: string;
  error: string;
  latency_ms: number;
}

export interface ThinkingBlock {
  type: 'thinking' | 'redacted_thinking';
  thinking?: string;
  data?: string;
  signature?: string;
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  input_tokens: number;
  output_tokens: number;
  finish_reason: string;
  tool_calls?: ToolCall[];
  thinking?: ThinkingBlock[];
  fallback_attempts?: FallbackAttempt[];
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ChatChunk {
  id: string;
  model: string;
  delta: string;
  finish_reason: string | null;
  input_tokens?: number;
  output_tokens?: number;
  tool_calls?: ToolCall[];
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'down';
  latency_ms: number;
  message?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: string;
  base_url?: string;
  config: Record<string, unknown>;
  credentials: Record<string, string>;
  priority: number;
  is_enabled: boolean;
}
