import { getDb } from '../db/index.js';
import { decrypt } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { ProviderError } from '../utils/errors.js';
import { BaseProvider, setEncryptionKey } from './base.js';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';
import type { ProviderConfig, ChatRequest, ChatResponse, ChatChunk, HealthStatus, FallbackAttempt } from './types.js';

const providers = new Map<string, BaseProvider>();

function createProvider(row: any, encryptionKey: string): BaseProvider {
  const config: ProviderConfig = {
    id: row.id,
    name: row.name,
    type: row.type,
    base_url: row.base_url || undefined,
    config: JSON.parse(row.config || '{}'),
    credentials: decryptCredentials(row.credentials, encryptionKey),
    priority: row.priority,
    is_enabled: Boolean(row.is_enabled),
  };

  switch (row.type) {
    case 'claude': return new ClaudeProvider(config);
    case 'openai': return new OpenAIProvider(config);
    case 'gemini': return new GeminiProvider(config);
    case 'ollama': return new OllamaProvider(config);
    default: throw new Error(`Unknown provider type: ${row.type}`);
  }
}

function decryptCredentials(encrypted: string, key: string): Record<string, string> {
  try {
    const raw = decrypt(encrypted, key);
    return JSON.parse(raw);
  } catch {
    // Might be plain JSON (first run or migration)
    try { return JSON.parse(encrypted); } catch { return {}; }
  }
}

let _refreshInterval: ReturnType<typeof setInterval> | null = null;

export function loadProviders(encryptionKey: string): void {
  setEncryptionKey(encryptionKey);
  const db = getDb();
  const rows = db.prepare('SELECT * FROM providers WHERE is_enabled = 1 ORDER BY priority DESC').all();
  providers.clear();
  for (const r of rows) {
    const row = r as any;
    try {
      providers.set(row.id, createProvider(row, encryptionKey));
      logger.info({ id: row.id, type: row.type }, 'Provider loaded');
    } catch (err: any) {
      logger.error({ id: row.id, err: err.message }, 'Failed to load provider');
    }
  }

  // Start background token refresh — every 15 min, proactively refresh expiring tokens
  // OAuth tokens (Claude, OpenAI, Gemini) typically expire in 1-8 hours.
  // We refresh 30 min before expiry to avoid any request-time failures.
  if (_refreshInterval) clearInterval(_refreshInterval);
  const refreshAllTokens = async () => {
    for (const [id, provider] of providers) {
      try {
        const creds = (provider as any).config?.credentials;
        if (!creds?.expires_at) continue;
        const expiresMs = Number(creds.expires_at);
        const bufferMs = 30 * 60 * 1000; // refresh 30 min before expiry
        if (Date.now() + bufferMs >= expiresMs) {
          logger.info({ id, type: (provider as any).type }, 'Background token refresh');
          const refreshed = await provider.refreshToken();
          if (refreshed) {
            db.prepare("UPDATE providers SET health_status = 'healthy' WHERE id = ?").run(id);
          } else {
            // Token refresh failed — mark as degraded so dashboard shows warning
            const timeLeft = expiresMs - Date.now();
            if (timeLeft <= 0) {
              logger.error({ id, type: (provider as any).type }, 'Token expired and refresh failed — provider DOWN');
              db.prepare("UPDATE providers SET health_status = 'down' WHERE id = ?").run(id);
            } else {
              logger.warn({ id, type: (provider as any).type, expiresInMin: Math.round(timeLeft / 60000) }, 'Token refresh failed — will retry');
              db.prepare("UPDATE providers SET health_status = 'degraded' WHERE id = ?").run(id);
            }
          }
        }
      } catch (err: any) {
        logger.error({ id, err: err.message }, 'Background refresh error');
      }
    }
  };
  // Run immediately on startup, then every 15 min
  refreshAllTokens();
  _refreshInterval = setInterval(refreshAllTokens, 15 * 60 * 1000);
}

export function getProvider(id: string): BaseProvider | undefined {
  return providers.get(id);
}

export function getAllProviders(): BaseProvider[] {
  return Array.from(providers.values());
}

export function getDefaultProvider(): BaseProvider | undefined {
  // Highest priority enabled provider
  return getAllProviders()[0];
}

function getProviderHealth(id: string): string {
  const db = getDb();
  const row = db.prepare('SELECT health_status FROM providers WHERE id = ?').get(id) as { health_status: string } | undefined;
  return row?.health_status || 'unknown';
}

const DEFAULT_TIMEOUT_MS = 120000;       // 120s for non-streaming (thinking models need time)
const DEFAULT_STREAM_TIMEOUT_MS = 60000; // 60s for first chunk in streaming

function getProviderConfig(id: string): Record<string, unknown> {
  const provider = providers.get(id);
  if (!provider) return {};
  return (provider as any).config?.config || {};
}

function getProviderTimeout(id: string): number {
  const config = getProviderConfig(id);
  return (config.timeout_ms as number) || DEFAULT_TIMEOUT_MS;
}

function getProviderStreamTimeout(id: string): number {
  const config = getProviderConfig(id);
  return (config.stream_timeout_ms as number) || DEFAULT_STREAM_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms — increase timeout in provider settings`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function chatWithFallback(
  providerIds: string[],
  params: ChatRequest,
): Promise<{ provider: BaseProvider; response: ChatResponse }> {
  const attempts: FallbackAttempt[] = [];

  for (const id of providerIds) {
    const provider = providers.get(id);
    if (!provider) continue;

    const timeout = getProviderTimeout(id);
    const start = Date.now();

    try {
      const response = await withTimeout(provider.chat(params), timeout, id);
      // If it was marked down but just succeeded, update health
      const health = getProviderHealth(id);
      if (health === 'down') {
        getDb().prepare("UPDATE providers SET health_status = 'healthy' WHERE id = ?").run(id);
      }
      response.fallback_attempts = attempts.length > 0 ? attempts : undefined;
      return { provider, response };
    } catch (err: any) {
      const latency = Date.now() - start;
      logger.warn({ provider: id, err: err.message, latency_ms: latency }, 'Provider failed, trying fallback');
      attempts.push({ provider_id: id, provider_name: provider.name, error: err.message, latency_ms: latency });
    }
  }

  const summary = attempts.map(a => `${a.provider_name}: ${a.error}`).join('; ');
  throw new ProviderError('all', `All providers failed — ${summary}`);
}

export async function* streamWithFallback(
  providerIds: string[],
  params: ChatRequest,
): AsyncGenerator<{ provider: BaseProvider; chunk: ChatChunk; fallback_attempts?: FallbackAttempt[] }> {
  const attempts: FallbackAttempt[] = [];

  for (const id of providerIds) {
    const provider = providers.get(id);
    if (!provider) continue;

    const streamTimeout = getProviderStreamTimeout(id);
    const start = Date.now();

    try {
      let first = true;
      const stream = provider.chatStream(params);
      const iterator = stream[Symbol.asyncIterator]();

      // First chunk has a timeout — if provider hangs, fail over
      const firstResult = await withTimeout(
        iterator.next(),
        streamTimeout,
        `${id} stream first chunk`,
      );

      if (!firstResult.done) {
        if (attempts.length > 0) {
          yield { provider, chunk: firstResult.value, fallback_attempts: attempts };
        } else {
          yield { provider, chunk: firstResult.value };
        }
        first = false;
      }

      // Remaining chunks stream without timeout (response is flowing)
      while (true) {
        const result = await iterator.next();
        if (result.done) break;
        yield { provider, chunk: result.value };
      }
      return;
    } catch (err: any) {
      const latency = Date.now() - start;
      logger.warn({ provider: id, err: err.message, latency_ms: latency }, 'Stream provider failed, trying fallback');
      attempts.push({ provider_id: id, provider_name: provider.name, error: err.message, latency_ms: latency });
    }
  }

  const summary = attempts.map(a => `${a.provider_name}: ${a.error}`).join('; ');
  throw new ProviderError('all', `All providers failed — ${summary}`);
}

export async function checkAllHealth(encryptionKey: string): Promise<Map<string, HealthStatus>> {
  const results = new Map<string, HealthStatus>();
  const db = getDb();

  for (const [id, provider] of providers) {
    const health = await provider.healthCheck();
    results.set(id, health);

    db.prepare(
      'UPDATE providers SET health_status = ?, last_health_check = datetime(\'now\') WHERE id = ?'
    ).run(health.status, id);
  }

  return results;
}

export { BaseProvider };
