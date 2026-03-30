import { BaseProvider } from './base.js';
import type { ChatRequest, ChatResponse, ChatChunk, HealthStatus } from './types.js';
import { ProviderError } from '../utils/errors.js';
import { generateId } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

export class OpenAIProvider extends BaseProvider {
  readonly type = 'openai';

  // Detect ChatGPT OAuth mode (Codex-style token)
  private get isChatGPT(): boolean {
    return !!this.config.credentials.oauth_token;
  }

  private get accountId(): string {
    return this.config.credentials.account_id || '';
  }

  private get baseUrl(): string {
    if (this.isChatGPT) {
      return 'https://chatgpt.com/backend-api/codex';
    }
    return this.config.base_url || 'https://api.openai.com';
  }

  private get apiKey(): string {
    return this.config.credentials.api_key || this.config.credentials.oauth_token || '';
  }

  protected buildAuthHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.apiKey}`,
    };
    if (this.isChatGPT && this.accountId) {
      h['chatgpt-account-id'] = this.accountId;
    }
    return h;
  }

  defaultModel(): string {
    if (this.isChatGPT) {
      return (this.config.config.default_model as string) || 'gpt-5.4-mini';
    }
    return (this.config.config.default_model as string) || 'gpt-4o';
  }

  // Refresh OpenAI OAuth token — try Codex auth file first, then OAuth flow
  async refreshToken(): Promise<boolean> {
    // Strategy 1: Read from ~/.codex/auth.json (Codex keeps this fresh)
    try {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');
      const codexAuth = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf-8'));
      if (codexAuth.tokens?.access_token && codexAuth.tokens.access_token !== this.config.credentials.oauth_token) {
        this.config.credentials.oauth_token = codexAuth.tokens.access_token;
        if (codexAuth.tokens.refresh_token) this.config.credentials.refresh_token = codexAuth.tokens.refresh_token;
        this.config.credentials.expires_at = String(Date.now() + 3600 * 1000);
        this.persistCredentials();
        logger.info({ id: this.id }, 'OpenAI token refreshed from Codex auth file');
        return true;
      }
    } catch { /* Codex not installed or no auth file */ }

    // Strategy 2: OAuth refresh_token flow
    const refreshToken = this.config.credentials.refresh_token;
    const clientId = this.config.credentials.client_id;
    if (!refreshToken || !clientId) return false;

    try {
      const res = await fetch('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
        }).toString(),
      });

      if (!res.ok) return false;

      const data = await res.json() as any;
      if (!data.access_token) return false;

      this.config.credentials.oauth_token = data.access_token;
      if (data.expires_in) {
        this.config.credentials.expires_at = String(Date.now() + data.expires_in * 1000);
      }
      // OpenAI rotates refresh tokens
      if (data.refresh_token) {
        this.config.credentials.refresh_token = data.refresh_token;
      }

      this.persistCredentials();
      return true;
    } catch { return false; }
  }

  // === ChatGPT Codex Backend API (OAuth mode) ===

  private chatGPTBody(params: ChatRequest): string {
    const systemMsg = params.messages.find(m => m.role === 'system');
    const input = params.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    return JSON.stringify({
      model: params.model || this.defaultModel(),
      instructions: systemMsg?.content || 'You are a helpful assistant.',
      input,
      store: false,
      stream: true,
    });
  }

  private async chatGPTChat(params: ChatRequest): Promise<ChatResponse> {
    const model = params.model || this.defaultModel();
    const res = await this.fetchWithRefresh(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: this.buildAuthHeaders(),
      body: this.chatGPTBody(params),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ProviderError('openai', `${res.status}: ${err}`);
    }

    // Parse SSE stream to collect full response
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let responseId = generateId();

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
          if (!raw) continue;

          try {
            const event = JSON.parse(raw);
            if (event.type === 'response.output_text.delta') {
              fullText += event.delta || '';
            } else if (event.type === 'response.completed') {
              responseId = event.response?.id || responseId;
              inputTokens = event.response?.usage?.input_tokens || 0;
              outputTokens = event.response?.usage?.output_tokens || 0;
            }
          } catch { /* skip */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      id: responseId,
      model,
      content: fullText,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      finish_reason: 'stop',
    };
  }

  private async *chatGPTStream(params: ChatRequest): AsyncGenerator<ChatChunk> {
    const model = params.model || this.defaultModel();
    const res = await this.fetchWithRefresh(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: this.buildAuthHeaders(),
      body: this.chatGPTBody(params),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ProviderError('openai', `${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const id = generateId();

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
          if (!raw) continue;

          try {
            const event = JSON.parse(raw);
            if (event.type === 'response.output_text.delta' && event.delta) {
              yield { id, model, delta: event.delta, finish_reason: null };
            } else if (event.type === 'response.completed') {
              yield {
                id, model, delta: '', finish_reason: 'stop',
                input_tokens: event.response?.usage?.input_tokens,
                output_tokens: event.response?.usage?.output_tokens,
              };
            }
          } catch { /* skip */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // === Standard OpenAI Platform API (API key mode) ===

  async chat(params: ChatRequest): Promise<ChatResponse> {
    if (this.isChatGPT) return this.chatGPTChat(params);

    const model = params.model || this.defaultModel();
    const body: Record<string, unknown> = {
      model,
      messages: params.messages,
      max_completion_tokens: params.max_tokens || 4096,
    };
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.stop) body.stop = params.stop;
    if (params.response_schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response', strict: true, schema: params.response_schema },
      };
    }

    const res = await this.fetchWithRefresh(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.buildAuthHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ProviderError('openai', `${res.status}: ${err}`);
    }

    const data = await res.json() as any;
    const choice = data.choices?.[0];

    return {
      id: data.id || generateId(),
      model: data.model || model,
      content: choice?.message?.content || '',
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
      finish_reason: choice?.finish_reason || 'stop',
    };
  }

  async *chatStream(params: ChatRequest): AsyncGenerator<ChatChunk> {
    if (this.isChatGPT) {
      yield* this.chatGPTStream(params);
      return;
    }

    const model = params.model || this.defaultModel();
    const body: Record<string, unknown> = {
      model,
      messages: params.messages,
      max_completion_tokens: params.max_tokens || 4096,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (params.temperature !== undefined) body.temperature = params.temperature;

    const res = await this.fetchWithRefresh(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.buildAuthHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ProviderError('openai', `${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
          if (raw === '[DONE]') return;

          try {
            const event = JSON.parse(raw);
            const choice = event.choices?.[0];
            if (choice?.delta?.content) {
              yield {
                id: event.id || generateId(),
                model: event.model || model,
                delta: choice.delta.content,
                finish_reason: null,
              };
            }
            if (choice?.finish_reason) {
              yield {
                id: event.id || generateId(),
                model: event.model || model,
                delta: '',
                finish_reason: choice.finish_reason,
                input_tokens: event.usage?.prompt_tokens,
                output_tokens: event.usage?.completion_tokens,
              };
            }
          } catch { /* skip */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      if (this.isChatGPT) {
        // Lightweight check: send a minimal request to the Codex API
        const res = await this.fetchWithRefresh(`${this.baseUrl}/responses`, {
          method: 'POST',
          headers: this.buildAuthHeaders(),
          body: JSON.stringify({
            model: this.defaultModel(),
            instructions: 'hi',
            input: [{ role: 'user', content: 'hi' }],
            store: false,
            stream: true,
          }),
        });
        const latency = Date.now() - start;
        // Consume and discard the stream
        try { const reader = res.body?.getReader(); if (reader) { while (!(await reader.read()).done) {} reader.releaseLock(); } } catch {}
        if (res.ok) return { status: 'healthy', latency_ms: latency };
        if (res.status === 429) return { status: 'degraded', latency_ms: latency, message: 'Rate limited' };
        return { status: 'down', latency_ms: latency, message: `HTTP ${res.status}` };
      }

      // API key mode: /v1/models
      const res = await this.fetchWithRefresh(`${this.baseUrl}/v1/models`, {
        headers: { 'authorization': `Bearer ${this.apiKey}` },
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
    if (this.isChatGPT) {
      return ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex', 'gpt-5.1', 'gpt-5-codex', 'gpt-5'];
    }
    return ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'];
  }
}
