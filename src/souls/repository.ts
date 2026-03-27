import { getDb } from '../db/index.js';
import { generateId } from '../utils/crypto.js';
import type { Soul, CreateSoulInput, UpdateSoulInput } from './types.js';

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function rowToSoul(row: any): Soul {
  return {
    ...row,
    fallback_chain: JSON.parse(row.fallback_chain || '[]'),
    is_enabled: Boolean(row.is_enabled),
  };
}

export function getAllSouls(): Soul[] {
  return getDb().prepare('SELECT * FROM souls ORDER BY name').all().map(rowToSoul);
}

export function getSoulById(id: string): Soul | null {
  const row = getDb().prepare('SELECT * FROM souls WHERE id = ?').get(id);
  return row ? rowToSoul(row) : null;
}

export function getSoulBySlug(slug: string): Soul | null {
  const row = getDb().prepare('SELECT * FROM souls WHERE slug = ? AND is_enabled = 1').get(slug);
  return row ? rowToSoul(row) : null;
}

export function createSoul(input: CreateSoulInput): Soul {
  const id = generateId();
  const slug = input.slug || slugify(input.name);

  getDb().prepare(`
    INSERT INTO souls (id, name, slug, description, system_prompt, provider_id, fallback_chain, model, temperature, max_tokens, response_schema)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.name, slug, input.description || null,
    input.system_prompt, input.provider_id || null,
    JSON.stringify(input.fallback_chain || []),
    input.model || null, input.temperature ?? 0.7,
    input.max_tokens ?? 4096, input.response_schema || null,
  );

  return getSoulById(id)!;
}

export function updateSoul(id: string, input: UpdateSoulInput): Soul | null {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name); }
  if (input.description !== undefined) { sets.push('description = ?'); values.push(input.description); }
  if (input.system_prompt !== undefined) { sets.push('system_prompt = ?'); values.push(input.system_prompt); }
  if (input.provider_id !== undefined) { sets.push('provider_id = ?'); values.push(input.provider_id); }
  if (input.fallback_chain !== undefined) { sets.push('fallback_chain = ?'); values.push(JSON.stringify(input.fallback_chain)); }
  if (input.model !== undefined) { sets.push('model = ?'); values.push(input.model); }
  if (input.temperature !== undefined) { sets.push('temperature = ?'); values.push(input.temperature); }
  if (input.max_tokens !== undefined) { sets.push('max_tokens = ?'); values.push(input.max_tokens); }
  if (input.response_schema !== undefined) { sets.push('response_schema = ?'); values.push(input.response_schema); }
  if (input.is_enabled !== undefined) { sets.push('is_enabled = ?'); values.push(input.is_enabled ? 1 : 0); }

  if (sets.length === 0) return getSoulById(id);

  sets.push("updated_at = datetime('now')");
  values.push(id);

  getDb().prepare(`UPDATE souls SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getSoulById(id);
}

export function deleteSoul(id: string): boolean {
  const result = getDb().prepare('DELETE FROM souls WHERE id = ?').run(id);
  return result.changes > 0;
}
