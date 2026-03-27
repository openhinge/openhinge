export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  soul_id: string | null;
  soul_ids: string[];
  rate_limit_rpm: number;
  daily_budget_cents: number | null;
  monthly_budget_cents: number | null;
  expires_at: string | null;
  is_enabled: boolean;
  last_used_at: string | null;
  total_requests: number;
  created_at: string;
}

export interface CreateKeyInput {
  name: string;
  soul_id?: string;
  soul_ids?: string[];
  rate_limit_rpm?: number;
  daily_budget_cents?: number;
  monthly_budget_cents?: number;
  expires_at?: string;
}

export interface ApiKeyWithSecret extends ApiKey {
  key: string; // Only returned on creation
}
