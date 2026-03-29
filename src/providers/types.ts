export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  [key: string]: unknown;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string[];
  response_schema?: JsonSchema;
}

export interface FallbackAttempt {
  provider_id: string;
  provider_name: string;
  error: string;
  latency_ms: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  input_tokens: number;
  output_tokens: number;
  finish_reason: string;
  fallback_attempts?: FallbackAttempt[];
}

export interface ChatChunk {
  id: string;
  model: string;
  delta: string;
  finish_reason: string | null;
  input_tokens?: number;
  output_tokens?: number;
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
