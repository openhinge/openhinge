export interface Soul {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  system_prompt: string;
  provider_id: string | null;
  fallback_chain: string[];
  model: string | null;
  temperature: number;
  max_tokens: number;
  response_schema: string | null;
  version: number;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateSoulInput {
  name: string;
  slug?: string;
  description?: string;
  system_prompt: string;
  provider_id?: string;
  fallback_chain?: string[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  response_schema?: string;
}

export interface UpdateSoulInput {
  name?: string;
  description?: string;
  system_prompt?: string;
  provider_id?: string | null;
  fallback_chain?: string[];
  model?: string | null;
  temperature?: number;
  max_tokens?: number;
  response_schema?: string | null;
  is_enabled?: boolean;
}
