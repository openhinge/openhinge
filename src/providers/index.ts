import { getDb } from '../db/index.js';
import { decrypt } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { ProviderError } from '../utils/errors.js';
import { BaseProvider, setEncryptionKey } from './base.js';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';
import type { ProviderConfig, ChatRequest, ChatResponse, ChatChunk, HealthStatus } from './types.js';

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

export function loadProviders(encryptionKey: string): void {
  setEncryptionKey(encryptionKey);
  const db = getDb();
  const rows = db.prepare('SELECT * FROM providers WHERE is_enabled = 1 ORDER BY priority DESC').all();
  providers.clear();
  for (const row of rows) {
    try {
      providers.set(row.id, createProvider(row, encryptionKey));
      logger.info({ id: row.id, type: row.type }, 'Provider loaded');
    } catch (err: any) {
      logger.error({ id: row.id, err: err.message }, 'Failed to load provider');
    }
  }
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

export async function chatWithFallback(
  providerIds: string[],
  params: ChatRequest,
): Promise<{ provider: BaseProvider; response: ChatResponse }> {
  for (const id of providerIds) {
    const provider = providers.get(id);
    if (!provider) continue;

    try {
      const response = await provider.chat(params);
      return { provider, response };
    } catch (err: any) {
      logger.warn({ provider: id, err: err.message }, 'Provider failed, trying fallback');
    }
  }
  throw new ProviderError('all', 'All providers in the chain failed');
}

export async function* streamWithFallback(
  providerIds: string[],
  params: ChatRequest,
): AsyncGenerator<{ provider: BaseProvider; chunk: ChatChunk }> {
  for (const id of providerIds) {
    const provider = providers.get(id);
    if (!provider) continue;

    try {
      for await (const chunk of provider.chatStream(params)) {
        yield { provider, chunk };
      }
      return;
    } catch (err: any) {
      logger.warn({ provider: id, err: err.message }, 'Stream provider failed, trying fallback');
    }
  }
  throw new ProviderError('all', 'All providers in the chain failed');
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
