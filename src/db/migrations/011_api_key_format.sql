-- Add api_format column to track which API compatibility format the key targets
ALTER TABLE api_keys ADD COLUMN api_format TEXT NOT NULL DEFAULT 'openai';
