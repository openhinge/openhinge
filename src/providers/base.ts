import type { ChatRequest, ChatResponse, ChatChunk, HealthStatus, ProviderConfig } from './types.js';
import { getDb } from '../db/index.js';
import { encrypt } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

// Global ref to encryption key — set once at startup
let _encryptionKey = '';
export function setEncryptionKey(key: string) { _encryptionKey = key; }
export function getEncryptionKey(): string { return _encryptionKey; }

export abstract class BaseProvider {
  abstract readonly type: string;

  constructor(protected config: ProviderConfig) {}

  get id(): string { return this.config.id; }
  get name(): string { return this.config.name; }

  abstract chat(params: ChatRequest): Promise<ChatResponse>;
  abstract chatStream(params: ChatRequest): AsyncGenerator<ChatChunk>;
  abstract healthCheck(): Promise<HealthStatus>;
  abstract listModels(): Promise<string[]>;
  abstract defaultModel(): string;

  /**
   * Override in subclasses that support token refresh.
   * Should return true if refresh succeeded and this.config.credentials was updated.
   */
  async refreshToken(): Promise<boolean> {
    return false;
  }

  /**
   * Persist updated credentials back to the database.
   */
  protected persistCredentials(): void {
    const key = getEncryptionKey();
    if (!key || this.config.id === 'probe') return;
    try {
      const encCreds = encrypt(JSON.stringify(this.config.credentials), key);
      getDb().prepare(
        "UPDATE providers SET credentials = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(encCreds, this.config.id);
      logger.info({ id: this.config.id, type: this.type }, 'Token refreshed and persisted');
    } catch (err: any) {
      logger.error({ id: this.config.id, err: err.message }, 'Failed to persist refreshed credentials');
    }
  }

  /**
   * Wrapper for fetch that retries once on 401 after attempting token refresh.
   */
  protected async fetchWithRefresh(url: string, init: RequestInit): Promise<Response> {
    const res = await fetch(url, init);
    if (res.status === 401) {
      const refreshed = await this.refreshToken();
      if (refreshed) {
        // Rebuild headers with new token and retry
        const newInit = { ...init, headers: this.buildAuthHeaders() };
        return fetch(url, newInit);
      }
    }
    return res;
  }

  /**
   * Override to return fresh auth headers after a token refresh.
   */
  protected buildAuthHeaders(): Record<string, string> {
    return {};
  }
}
