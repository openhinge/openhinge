CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Default settings
INSERT INTO settings (key, value) VALUES ('cloudflare', '{"enabled":false,"api_token":"","account_id":"","tunnel_id":"","zone_id":"","domain":""}');
INSERT INTO settings (key, value) VALUES ('general', '{"name":"OpenHinge","timezone":"UTC","daily_budget_cents":0}');
