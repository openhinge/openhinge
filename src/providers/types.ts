export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string[];
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  input_tokens: number;
  output_tokens: number;
  finish_reason: string;
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
