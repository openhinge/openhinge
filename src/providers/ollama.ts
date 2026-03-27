import { BaseProvider } from './base.js';
import type { ChatRequest, ChatResponse, ChatChunk, HealthStatus } from './types.js';
import { ProviderError } from '../utils/errors.js';
import { generateId } from '../utils/crypto.js';

export class OllamaProvider extends BaseProvider {
  readonly type = 'ollama';

  private get baseUrl(): string {
    return this.config.base_url || 'http://127.0.0.1:11434';
  }

  defaultModel(): string {
    return (this.config.config.default_model as string) || 'qwen3:8b';
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const model = params.model || this.defaultModel();

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: params.messages,
        stream: false,
        options: {
          temperature: params.temperature,
          num_predict: params.max_tokens,
          stop: params.stop,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ProviderError('ollama', `${res.status}: ${err}`);
    }

    const data = await res.json() as any;

    return {
      id: generateId(),
      model: data.model || model,
      content: data.message?.content || '',
      input_tokens: data.prompt_eval_count || 0,
      output_tokens: data.eval_count || 0,
      finish_reason: data.done_reason || 'stop',
    };
  }

  async *chatStream(params: ChatRequest): AsyncGenerator<ChatChunk> {
    const model = params.model || this.defaultModel();
    const id = generateId();

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: params.messages,
        stream: true,
        options: {
          temperature: params.temperature,
          num_predict: params.max_tokens,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ProviderError('ollama', `${res.status}: ${err}`);
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
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.message?.content) {
              yield { id, model, delta: event.message.content, finish_reason: null };
            }
            if (event.done) {
              yield {
                id, model, delta: '',
                finish_reason: event.done_reason || 'stop',
                input_tokens: event.prompt_eval_count,
                output_tokens: event.eval_count,
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
      const res = await fetch(`${this.baseUrl}/api/tags`);
      const latency = Date.now() - start;
      if (res.ok) return { status: 'healthy', latency_ms: latency };
      return { status: 'down', latency_ms: latency, message: `HTTP ${res.status}` };
    } catch (err: any) {
      return { status: 'down', latency_ms: Date.now() - start, message: err.message };
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = await res.json() as any;
      return (data.models || []).map((m: any) => m.name);
    } catch {
      return [];
    }
  }
}
