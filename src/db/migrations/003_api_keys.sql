CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  soul_id TEXT,
  rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
  daily_budget_cents INTEGER,
  monthly_budget_cents INTEGER,
  expires_at TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  total_requests INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (soul_id) REFERENCES souls(id) ON DELETE SET NULL
);
