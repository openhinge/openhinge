-- Multi-soul support for API keys
CREATE TABLE IF NOT EXISTS api_key_souls (
  api_key_id TEXT NOT NULL,
  soul_id TEXT NOT NULL,
  PRIMARY KEY (api_key_id, soul_id),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
  FOREIGN KEY (soul_id) REFERENCES souls(id) ON DELETE CASCADE
);
