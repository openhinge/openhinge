import { getDb } from '../db/index.js';
import { generateId } from '../utils/crypto.js';
import { calculateCostCents } from '../utils/tokens.js';

export interface UsageEntry {
  request_id: string;
  api_key_id: string;
  soul_id: string;
  provider_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  latency_ms: number;
  status: string;
  error_message?: string;
}

export function logUsage(entry: UsageEntry): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO usage_logs (request_id, api_key_id, soul_id, provider_id, model, input_tokens, output_tokens, cost_cents, latency_ms, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.request_id, entry.api_key_id, entry.soul_id, entry.provider_id,
    entry.model, entry.input_tokens, entry.output_tokens, entry.cost_cents,
    entry.latency_ms, entry.status, entry.error_message || null,
  );

  // Upsert daily aggregate
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO cost_daily (date, api_key_id, soul_id, provider_id, total_requests, total_input_tokens, total_output_tokens, total_cost_cents)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(date, api_key_id, soul_id, provider_id) DO UPDATE SET
      total_requests = total_requests + 1,
      total_input_tokens = total_input_tokens + excluded.total_input_tokens,
      total_output_tokens = total_output_tokens + excluded.total_output_tokens,
      total_cost_cents = total_cost_cents + excluded.total_cost_cents
  `).run(today, entry.api_key_id, entry.soul_id, entry.provider_id, entry.input_tokens, entry.output_tokens, entry.cost_cents);
}

export function getDailySpend(keyId: string, date?: string): number {
  const d = date || new Date().toISOString().slice(0, 10);
  const row = getDb().prepare(
    'SELECT SUM(total_cost_cents) as total FROM cost_daily WHERE api_key_id = ? AND date = ?'
  ).get(keyId, d) as any;
  return row?.total || 0;
}

export function getMonthlySpend(keyId: string): number {
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  const row = getDb().prepare(
    'SELECT SUM(total_cost_cents) as total FROM cost_daily WHERE api_key_id = ? AND date >= ?'
  ).get(keyId, monthStart) as any;
  return row?.total || 0;
}

export function getCostReport(days = 30): any[] {
  return getDb().prepare(`
    SELECT date, SUM(total_requests) as requests, SUM(total_input_tokens) as input_tokens,
           SUM(total_output_tokens) as output_tokens, SUM(total_cost_cents) as cost_cents
    FROM cost_daily
    WHERE date >= date('now', '-' || ? || ' days')
    GROUP BY date ORDER BY date DESC
  `).all(days);
}

export function getCostBySoul(days = 30): any[] {
  return getDb().prepare(`
    SELECT s.name as soul_name, s.slug, SUM(c.total_requests) as requests,
           SUM(c.total_cost_cents) as cost_cents
    FROM cost_daily c JOIN souls s ON c.soul_id = s.id
    WHERE c.date >= date('now', '-' || ? || ' days')
    GROUP BY c.soul_id ORDER BY cost_cents DESC
  `).all(days);
}

export function getRecentLogs(limit = 50): any[] {
  return getDb().prepare(`
    SELECT u.*, s.name as soul_name, p.name as provider_name, k.name as key_name
    FROM usage_logs u
    LEFT JOIN souls s ON u.soul_id = s.id
    LEFT JOIN providers p ON u.provider_id = p.id
    LEFT JOIN api_keys k ON u.api_key_id = k.id
    ORDER BY u.created_at DESC LIMIT ?
  `).all(limit);
}

export interface LogQuery {
  page?: number;
  per_page?: number;
  soul_id?: string;
  provider_id?: string;
  api_key_id?: string;
  model?: string;
  status?: string;
  search?: string;
  from?: string;
  to?: string;
  sort?: string;       // column name
  order?: 'asc' | 'desc';
}

export function queryLogs(q: LogQuery): { data: any[]; total: number; page: number; per_page: number; pages: number } {
  const page = Math.max(1, q.page || 1);
  const perPage = Math.min(200, Math.max(1, q.per_page || 50));
  const offset = (page - 1) * perPage;

  const conditions: string[] = [];
  const params: any[] = [];

  if (q.soul_id) { conditions.push('u.soul_id = ?'); params.push(q.soul_id); }
  if (q.provider_id) { conditions.push('u.provider_id = ?'); params.push(q.provider_id); }
  if (q.api_key_id) { conditions.push('u.api_key_id = ?'); params.push(q.api_key_id); }
  if (q.model) { conditions.push('u.model LIKE ?'); params.push(`%${q.model}%`); }
  if (q.status) { conditions.push('u.status = ?'); params.push(q.status); }
  if (q.from) { conditions.push('u.created_at >= ?'); params.push(q.from); }
  if (q.to) { conditions.push('u.created_at <= ?'); params.push(q.to); }
  if (q.search) {
    conditions.push('(u.model LIKE ? OR u.error_message LIKE ? OR u.request_id LIKE ? OR s.name LIKE ? OR p.name LIKE ? OR k.name LIKE ?)');
    const term = `%${q.search}%`;
    params.push(term, term, term, term, term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Allowed sort columns
  const sortCols: Record<string, string> = {
    created_at: 'u.created_at', latency_ms: 'u.latency_ms',
    input_tokens: 'u.input_tokens', output_tokens: 'u.output_tokens',
    cost_cents: 'u.cost_cents', model: 'u.model', status: 'u.status',
  };
  const sortCol = sortCols[q.sort || 'created_at'] || 'u.created_at';
  const sortOrder = q.order === 'asc' ? 'ASC' : 'DESC';

  const db = getDb();

  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM usage_logs u
    LEFT JOIN souls s ON u.soul_id = s.id
    LEFT JOIN providers p ON u.provider_id = p.id
    LEFT JOIN api_keys k ON u.api_key_id = k.id
    ${where}
  `).get(...params) as any;
  const total = countRow?.cnt || 0;

  const data = db.prepare(`
    SELECT u.*, s.name as soul_name, p.name as provider_name, k.name as key_name
    FROM usage_logs u
    LEFT JOIN souls s ON u.soul_id = s.id
    LEFT JOIN providers p ON u.provider_id = p.id
    LEFT JOIN api_keys k ON u.api_key_id = k.id
    ${where}
    ORDER BY ${sortCol} ${sortOrder}
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset);

  return { data, total, page, per_page: perPage, pages: Math.ceil(total / perPage) || 1 };
}
