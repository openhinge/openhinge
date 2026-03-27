import { getDb } from '../db/index.js';
import { generateId, generateApiKey, hashApiKey, verifyApiKey } from '../utils/crypto.js';
import type { ApiKey, CreateKeyInput, ApiKeyWithSecret } from './types.js';

function rowToKey(row: any): ApiKey {
  const db = getDb();
  const soulRows = db.prepare('SELECT soul_id FROM api_key_souls WHERE api_key_id = ?').all(row.id) as any[];
  return {
    ...row,
    is_enabled: Boolean(row.is_enabled),
    soul_ids: soulRows.map((r: any) => r.soul_id),
  };
}

export function getAllKeys(): ApiKey[] {
  return getDb().prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all().map(rowToKey);
}

export function getKeyById(id: string): ApiKey | null {
  const row = getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  return row ? rowToKey(row) : null;
}

export function createKey(input: CreateKeyInput): ApiKeyWithSecret {
  const id = generateId();
  const { key, prefix } = generateApiKey();
  const keyHash = hashApiKey(key);
  const db = getDb();

  db.prepare(`
    INSERT INTO api_keys (id, name, key_hash, key_prefix, soul_id, rate_limit_rpm, daily_budget_cents, monthly_budget_cents, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.name, keyHash, prefix,
    null, // soul_id kept null — we use the junction table now
    input.rate_limit_rpm ?? 60,
    input.daily_budget_cents ?? null,
    input.monthly_budget_cents ?? null,
    input.expires_at ?? null,
  );

  // Insert soul bindings
  const soulIds = input.soul_ids || (input.soul_id ? [input.soul_id] : []);
  const insertSoul = db.prepare('INSERT INTO api_key_souls (api_key_id, soul_id) VALUES (?, ?)');
  for (const soulId of soulIds) {
    insertSoul.run(id, soulId);
  }

  const created = getKeyById(id)!;
  return { ...created, key };
}

export function validateKey(rawKey: string): ApiKey | null {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM api_keys WHERE is_enabled = 1'
  ).all();

  for (const row of rows) {
    if (verifyApiKey(rawKey, row.key_hash)) {
      // Check expiry
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return null;
      }

      // Update last used
      db.prepare(
        "UPDATE api_keys SET last_used_at = datetime('now'), total_requests = total_requests + 1 WHERE id = ?"
      ).run(row.id);

      return rowToKey(row);
    }
  }

  return null;
}

export function revokeKey(id: string): boolean {
  const result = getDb().prepare('UPDATE api_keys SET is_enabled = 0 WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteKey(id: string): boolean {
  const db = getDb();
  db.prepare('DELETE FROM api_key_souls WHERE api_key_id = ?').run(id);
  const result = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  return result.changes > 0;
}
