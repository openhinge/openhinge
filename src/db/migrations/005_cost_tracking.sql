CREATE TABLE cost_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  api_key_id TEXT,
  soul_id TEXT,
  provider_id TEXT,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_cents REAL NOT NULL DEFAULT 0,
  UNIQUE(date, api_key_id, soul_id, provider_id)
);

CREATE INDEX idx_cost_date ON cost_daily(date);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('global','soul','key')),
  scope_id TEXT,
  daily_limit_cents INTEGER,
  monthly_limit_cents INTEGER,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
