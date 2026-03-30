import { BaseProvider } from './base.js';
import type { ChatRequest, ChatResponse, ChatChunk, HealthStatus } from './types.js';
import { ProviderError } from '../utils/errors.js';
import { generateId } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

export class ClaudeProvider extends BaseProvider {
  readonly type = 'claude';

  private get baseUrl(): string {
    return this.config.base_url || 'https://api.anthropic.com';
  }

  private get apiKey(): string {
    return this.config.credentials.api_key || this.config.credentials.oauth_token || '';
  }

  private get isSubscription(): boolean {
    return this.apiKey.startsWith('sk-ant-oat01-');
  }

  protected buildAuthHeaders(): Record<string, string> {
    return this.headers();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (this.isSubscription || this.config.credentials.oauth_token) {
      h['authorization'] = `Bearer ${this.apiKey}`;
      h['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20';
      h['user-agent'] = 'claude-cli/2.1.62';
      h['x-app'] = 'cli';
    } else {
      h['x-api-key'] = this.apiKey;
    }
    return h;
  }

  defaultModel(): string {
    if (this.config.config.default_model) return this.config.config.default_model as string;
    return 'claude-sonnet-4-6';
  }

  // Try reading fresh token from macOS Keychain first (like OpenClaw),
  // then fall back to OAuth refresh_token flow
  async refreshToken(): Promise<boolean> {
    // Strategy 1: Read from macOS Keychain — Claude Code keeps this fresh
    // Only use keychain if this provider was originally imported from keychain
    // (has client_id matching Claude Code's) to avoid cross-account contamination
    if (this.isSubscription && this.config.credentials.client_id === '9d1c250a-e61b-44d9-88ed-5944d1962f5e') {
      try {
        const { execSync } = await import('node:child_process');
        const raw = execSync(
          'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
        const creds = JSON.parse(raw);
        const oauth = creds.claudeAiOauth;
        if (oauth?.accessToken && oauth.accessToken !== this.config.credentials.oauth_token) {
          this.config.credentials.oauth_token = oauth.accessToken;
          if (oauth.refreshToken) this.config.credentials.refresh_token = oauth.refreshToken;
          if (oauth.expiresAt) this.config.credentials.expires_at = String(oauth.expiresAt);
          this.persistCredentials();
          logger.info({ id: this.id }, 'Claude token refreshed from macOS Keychain');
          return true;
        }
      } catch {
        // Not on macOS or Claude Code not installed — fall through to OAuth
      }
    }

    // Strategy 2: OAuth refresh_token flow — works on any platform
    const refreshToken = this.config.credentials.refresh_token;
    const clientId = this.config.credentials.client_id;
    if (!refreshToken || !clientId) {
      logger.debug({ id: this.id }, 'No refresh_token or client_id for Claude OAuth refresh');
      return false;
    }

    try {
      const res = await fetch('https://platform.claude.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          scope: 'user:profile user:inference',
        }),
      });

      if (!res.ok) {
        logger.warn({ id: this.id, status: res.status }, 'Claude OAuth refresh failed');
        return false;
      }

      const data = await res.json() as any;
      if (!data.access_token) return false;

      this.config.credentials.oauth_token = data.access_token;
      if (data.expires_in) {
        this.config.credentials.expires_at = String(Date.now() + data.expires_in * 1000);
      }
      if (data.refresh_token) {
        this.config.credentials.refresh_token = data.refresh_token;
      }

      this.persistCredentials();
      logger.info({ id: this.id }, 'Claude OAuth token refreshed successfully');
      return true;
    } catch (err: any) {
      logger.error({ id: this.id, err: err.message }, 'Claude OAuth refresh error');
      return false;
    }
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const model = params.model || this.defaultModel();
    const systemMsg = params.messages.find(m => m.role === 'system');
    const messages = params.messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: params.max_tokens || 4096,
    };
    // Subscription tokens require exact Claude Code identity as system prompt
    if (this.isSubscription) {
      body.system = "You are Claude Code, Anthropic's official CLI for Claude.";
      // Inject soul/system prompt as a user instruction since subscription API
      // rejects modified system prompts
      if (systemMsg) {
        // Merge with first user message to avoid consecutive user messages
        if (messages.length > 0 && messages[0].role === 'user') {
          messages[0] = { role: 'user', content: `[System Instructions: ${systemMsg.content}]\n\n${messages[0].content}` };
        } else {
          messages.unshift({ role: 'user', content: `[System Instructions: ${systemMsg.content}]` });
        }
      }
    } else if (systemMsg) {
      body.system = systemMsg.content;
    }
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.stop) body.stop_sequences = params.stop;
    if (params.response_schema) {
      body.tools = [{
        name: 'structured_response',
        description: 'Return structured JSON matching the schema',
        input_schema: params.response_schema,
      }];
      body.tool_choice = { type: 'tool', name: 'structured_response' };
    }

    logger.debug({ url: `${this.baseUrl}/v1/messages`, model, isSubscription: this.isSubscription }, 'Claude chat request');

    const res = await this.fetchWithRefresh(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      logger.error({ status: res.status, error: err, model, isSubscription: this.isSubscription }, 'Claude chat error');
      throw new ProviderError('claude', `${res.status}: ${err}`);
    }

    const data = await res.json() as any;

    // If structured output was requested, extract from tool_use block
    let content: string;
    if (params.response_schema) {
      const toolBlock = data.content?.find((b: any) => b.type === 'tool_use');
      content = toolBlock ? JSON.stringify(toolBlock.input) : '';
    } else {
      const textBlock = data.content?.find((b: any) => b.type === 'text');
      content = textBlock?.text || '';
    }

    return {
      id: data.id || generateId(),
      model: data.model || model,
      content,
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0,
      finish_reason: data.stop_reason || 'end_turn',
    };
  }

  async *chatStream(params: ChatRequest): AsyncGenerator<ChatChunk> {
    const model = params.model || this.defaultModel();
    const systemMsg = params.messages.find(m => m.role === 'system');
    const messages = params.messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: params.max_tokens || 4096,
      stream: true,
    };
    if (this.isSubscription) {
      body.system = "You are Claude Code, Anthropic's official CLI for Claude.";
      if (systemMsg) {
        if (messages.length > 0 && messages[0].role === 'user') {
          messages[0] = { role: 'user', content: `[System Instructions: ${systemMsg.content}]\n\n${messages[0].content}` };
        } else {
          messages.unshift({ role: 'user', content: `[System Instructions: ${systemMsg.content}]` });
        }
      }
    } else if (systemMsg) {
      body.system = systemMsg.content;
    }
    if (params.temperature !== undefined) body.temperature = params.temperature;

    const res = await this.fetchWithRefresh(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ProviderError('claude', `${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const id = generateId();
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;

          try {
            const event = JSON.parse(raw);

            if (event.type === 'message_start') {
              inputTokens = event.message?.usage?.input_tokens || 0;
            } else if (event.type === 'content_block_delta' && event.delta?.text) {
              yield { id, model, delta: event.delta.text, finish_reason: null };
            } else if (event.type === 'message_delta') {
              outputTokens = event.usage?.output_tokens || 0;
              yield { id, model, delta: '', finish_reason: event.delta?.stop_reason || 'end_turn', input_tokens: inputTokens, output_tokens: outputTokens };
            }
          } catch { /* skip malformed */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const res = await this.fetchWithRefresh(`${this.baseUrl}/v1/models`, {
        headers: this.headers(),
      });
      const latency = Date.now() - start;
      if (res.ok) return { status: 'healthy', latency_ms: latency };
      if (res.status === 429) return { status: 'degraded', latency_ms: latency, message: 'Rate limited' };
      return { status: 'down', latency_ms: latency, message: `HTTP ${res.status}` };
    } catch (err: any) {
      return { status: 'down', latency_ms: Date.now() - start, message: err.message };
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, { headers: this.headers() });
      if (res.ok) {
        const data = await res.json() as any;
        const models = (data.data || []).map((m: any) => m.id).filter(Boolean);
        if (models.length > 0) return models;
      }
    } catch { /* fallback to static list */ }
    return [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ];
  }
}
