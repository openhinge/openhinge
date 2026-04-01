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
   * Check if the token is expired or about to expire (within 5 min).
   * If so, attempt a proactive refresh.
   */
  protected async ensureFreshToken(): Promise<void> {
    const expiresAt = this.config.credentials.expires_at;
    if (!expiresAt) {
      // No expiry tracked (e.g. Claude Code keychain import) — still try refresh
      // for subscription tokens so we always have the latest from credential store
      const token = this.config.credentials.oauth_token || this.config.credentials.api_key || '';
      if (token.startsWith('sk-ant-oat01-') || this.config.credentials.source === 'claude_code') {
        await this.refreshToken();
      }
      return;
    }

    const expiresMs = Number(expiresAt);
    const bufferMs = 5 * 60 * 1000; // refresh 5 min before expiry
    if (Date.now() + bufferMs >= expiresMs) {
      logger.info({ id: this.config.id, type: this.type }, 'Token expiring soon, proactively refreshing');
      await this.refreshToken();
    }
  }

  /**
   * Wrapper for fetch that proactively refreshes expiring tokens
   * and retries once on 401 after attempting token refresh.
   */
  protected async fetchWithRefresh(url: string, init: RequestInit): Promise<Response> {
    // Proactive refresh before the request
    await this.ensureFreshToken();

    // Rebuild headers in case token was just refreshed
    const freshInit = { ...init, headers: this.buildAuthHeaders() };
    const res = await fetch(url, freshInit);

    if (res.status === 401) {
      const refreshed = await this.refreshToken();
      if (refreshed) {
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
