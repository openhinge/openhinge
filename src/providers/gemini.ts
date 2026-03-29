import { BaseProvider } from './base.js';
import type { ChatRequest, ChatResponse, ChatChunk, HealthStatus } from './types.js';
import { ProviderError } from '../utils/errors.js';
import { generateId } from '../utils/crypto.js';

export class GeminiProvider extends BaseProvider {
  readonly type = 'gemini';

  private get isOAuth(): boolean {
    return !!this.config.credentials.oauth_token;
  }

  private get oauthData(): { token: string; projectId: string } {
    const raw = this.config.credentials.oauth_token || '';
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        return { token: parsed.token || parsed.access_token || '', projectId: parsed.projectId || '' };
      } catch { /* not JSON */ }
    }
    return { token: raw, projectId: '' };
  }

  private get apiKey(): string {
    return this.config.credentials.api_key || '';
  }

  private get baseUrl(): string {
    if (this.isOAuth) {
      return this.config.base_url || 'https://cloudcode-pa.googleapis.com';
    }
    return this.config.base_url || 'https://generativelanguage.googleapis.com/v1beta';
  }

  protected buildAuthHeaders(): Record<string, string> {
    return this.authHeaders();
  }

  private authHeaders(): Record<string, string> {
    if (this.isOAuth) {
      const { token } = this.oauthData;
      return {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
        'user-agent': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
        'x-goog-api-client': 'gl-node/22.17.0',
      };
    }
    return {
      'content-type': 'application/json',
      'x-goog-api-key': this.apiKey,
    };
  }

  defaultModel(): string {
    return (this.config.config.default_model as string) || 'gemini-2.5-flash';
  }

  // Refresh Google OAuth token using stored refresh_token
  async refreshToken(): Promise<boolean> {
    const refreshToken = this.config.credentials.refresh_token;
    const clientId = this.config.credentials.client_id;
    const clientSecret = this.config.credentials.client_secret;
    if (!refreshToken || !clientId) return false;

    try {
      const params: Record<string, string> = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      };
      if (clientSecret) params.client_secret = clientSecret;

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });

      if (!res.ok) return false;

      const data = await res.json() as any;
      const newToken = data.access_token;
      if (!newToken) return false;

      // Update oauth_token JSON with new access token
      const { projectId } = this.oauthData;
      this.config.credentials.oauth_token = JSON.stringify({ token: newToken, projectId });
      if (data.expires_in) {
        this.config.credentials.expires_at = String(Date.now() + data.expires_in * 1000);
      }
      // Google may return a new refresh_token (rare)
      if (data.refresh_token) {
        this.config.credentials.refresh_token = data.refresh_token;
      }

      this.persistCredentials();
      return true;
    } catch { return false; }
  }

  private toGeminiMessages(messages: ChatRequest['messages']) {
    const systemMsg = messages.find(m => m.role === 'system');
    const contents = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    return { systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined, contents };
  }

  private wrapOAuthBody(model: string, innerBody: Record<string, unknown>): string {
    const { projectId } = this.oauthData;
    return JSON.stringify({
      model,
      project: projectId,
      request: innerBody,
    });
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const model = params.model || this.defaultModel();
    const { systemInstruction, contents } = this.toGeminiMessages(params.messages);

    const genConfig: Record<string, unknown> = {
      maxOutputTokens: params.max_tokens || 4096,
      temperature: params.temperature,
      stopSequences: params.stop,
    };
    if (params.response_schema) {
      genConfig.responseMimeType = 'application/json';
      genConfig.responseSchema = params.response_schema;
    }

    const innerBody: Record<string, unknown> = {
      contents,
      generationConfig: genConfig,
    };
    if (systemInstruction) innerBody.systemInstruction = systemInstruction;

    let url: string;
    let body: string;

    if (this.isOAuth) {
      url = `${this.baseUrl}/v1internal:generateContent`;
      body = this.wrapOAuthBody(model, innerBody);
    } else {
      url = `${this.baseUrl}/models/${model}:generateContent`;
      body = JSON.stringify(innerBody);
    }

    const res = await this.fetchWithRefresh(url, {
      method: 'POST',
      headers: this.authHeaders(),
      body,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ProviderError('gemini', `${res.status}: ${err}`);
    }

    const raw = await res.json() as any;
    // OAuth wraps in { response: { candidates, usageMetadata } }, API key returns directly
    const data = raw.response || raw;
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map((p: any) => p.text).join('') || '';

    return {
      id: generateId(),
      model,
      content: text,
      input_tokens: data.usageMetadata?.promptTokenCount || 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
      finish_reason: candidate?.finishReason || 'STOP',
    };
  }

  async *chatStream(params: ChatRequest): AsyncGenerator<ChatChunk> {
    const model = params.model || this.defaultModel();
    const { systemInstruction, contents } = this.toGeminiMessages(params.messages);

    const innerBody: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: params.max_tokens || 4096,
        temperature: params.temperature,
      },
    };
    if (systemInstruction) innerBody.systemInstruction = systemInstruction;

    let url: string;
    let body: string;

    if (this.isOAuth) {
      url = `${this.baseUrl}/v1internal:streamGenerateContent?alt=sse`;
      body = this.wrapOAuthBody(model, innerBody);
    } else {
      url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`;
      body = JSON.stringify(innerBody);
    }

    const res = await this.fetchWithRefresh(url, {
      method: 'POST',
      headers: this.authHeaders(),
      body,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ProviderError('gemini', `${res.status}: ${err}`);
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
            const rawEvent = JSON.parse(raw);
            // OAuth wraps in { response: ... }, API key returns directly
            const event = rawEvent.response || rawEvent;
            const text = event.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
            const finish = event.candidates?.[0]?.finishReason;

            if (text) {
              yield { id, model, delta: text, finish_reason: null };
            }
            if (finish && finish !== 'STOP') {
              yield { id, model, delta: '', finish_reason: finish };
            }
            if (event.usageMetadata) {
              yield {
                id, model, delta: '', finish_reason: finish || 'STOP',
                input_tokens: event.usageMetadata.promptTokenCount,
                output_tokens: event.usageMetadata.candidatesTokenCount,
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
      if (this.isOAuth) {
        // Use loadCodeAssist as a lightweight auth check — no generation quota consumed
        const res = await this.fetchWithRefresh('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify({
            metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI', platform: 'PLATFORM_UNSPECIFIED' },
          }),
        });
        const latency = Date.now() - start;
        // loadCodeAssist returns 200 if auth is valid (even if no project found)
        if (res.ok) return { status: 'healthy', latency_ms: latency };
        if (res.status === 401) return { status: 'down', latency_ms: latency, message: 'Token expired' };
        if (res.status === 429) return { status: 'degraded', latency_ms: latency, message: 'Rate limited' };
        return { status: 'down', latency_ms: latency, message: `HTTP ${res.status}` };
      }

      // API key mode — list models
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.authHeaders() });
      const latency = Date.now() - start;
      if (res.ok) return { status: 'healthy', latency_ms: latency };
      return { status: 'down', latency_ms: latency, message: `HTTP ${res.status}` };
    } catch (err: any) {
      return { status: 'down', latency_ms: Date.now() - start, message: err.message };
    }
  }

  async listModels(): Promise<string[]> {
    return ['gemini-2.5-pro', 'gemini-2.5-flash'];
  }
}
