import { BaseProvider } from './base.js';
import type { ChatRequest, ChatResponse, ChatChunk, HealthStatus, ToolCall, ThinkingBlock } from './types.js';
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

  private convertMessages(msgs: ChatRequest['messages']): any[] {
    const out: any[] = [];
    for (const m of msgs) {
      if (m.role === 'system') continue;
      if (m.role === 'assistant' && m.tool_calls?.length) {
        // Assistant message with tool calls → Anthropic format
        const content: any[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.tool_calls) {
          let input: unknown = {};
          try { input = JSON.parse(tc.function.arguments); } catch {}
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
        out.push({ role: 'assistant', content });
      } else if (m.role === 'tool' && m.tool_call_id) {
        // Tool result → Anthropic tool_result format
        out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] });
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const model = params.model || this.defaultModel();
    const systemMsg = params.messages.find(m => m.role === 'system');
    const messages = this.convertMessages(params.messages);

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
    if (params.top_p !== undefined) body.top_p = params.top_p;
    if (params.top_k !== undefined) body.top_k = params.top_k;
    if (params.metadata) body.metadata = params.metadata;
    if (params.thinking) body.thinking = params.thinking;
    if (params.service_tier) body.service_tier = params.service_tier;

    // Tools: client-provided tools take priority, then response_schema fallback
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map(t => {
        // Convert OpenAI format to Anthropic format if needed
        if (t.function) {
          return { name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object' } };
        }
        // Already Anthropic format
        return { name: t.name, description: t.description || '', input_schema: t.input_schema || { type: 'object' } };
      });
      if (params.tool_choice) {
        // Convert OpenAI tool_choice to Anthropic format
        if (params.tool_choice === 'auto') body.tool_choice = { type: 'auto' };
        else if (params.tool_choice === 'none') body.tool_choice = { type: 'none' };
        else if (params.tool_choice === 'required') body.tool_choice = { type: 'any' };
        else if (typeof params.tool_choice === 'object' && (params.tool_choice as any).function?.name) {
          body.tool_choice = { type: 'tool', name: (params.tool_choice as any).function.name };
        } else {
          body.tool_choice = params.tool_choice;
        }
      }
    } else if (params.response_schema) {
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

    // Extract text content
    const textBlocks = (data.content || []).filter((b: any) => b.type === 'text');
    let content = textBlocks.map((b: any) => b.text).join('');

    // If structured output was requested (not client tools), extract from tool_use block
    if (params.response_schema && !params.tools?.length) {
      const toolBlock = data.content?.find((b: any) => b.type === 'tool_use');
      if (toolBlock) content = JSON.stringify(toolBlock.input);
    }

    // Extract tool_calls if the model wants to call tools
    let toolCalls: ToolCall[] | undefined;
    const toolUseBlocks = (data.content || []).filter((b: any) => b.type === 'tool_use');
    if (toolUseBlocks.length > 0 && params.tools?.length) {
      toolCalls = toolUseBlocks.map((b: any) => ({
        id: b.id || `call_${generateId()}`,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));
    }

    // Extract thinking blocks
    let thinking: ThinkingBlock[] | undefined;
    const thinkingBlocks = (data.content || []).filter((b: any) => b.type === 'thinking' || b.type === 'redacted_thinking');
    if (thinkingBlocks.length > 0) {
      thinking = thinkingBlocks.map((b: any) => ({
        type: b.type,
        thinking: b.thinking,
        signature: b.signature,
        data: b.data,
      }));
    }

    return {
      id: data.id || generateId(),
      model: data.model || model,
      content,
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0,
      finish_reason: data.stop_reason || 'end_turn',
      tool_calls: toolCalls,
      thinking,
      cache_creation_input_tokens: data.usage?.cache_creation_input_tokens,
      cache_read_input_tokens: data.usage?.cache_read_input_tokens,
    };
  }

  async *chatStream(params: ChatRequest): AsyncGenerator<ChatChunk> {
    const model = params.model || this.defaultModel();
    const systemMsg = params.messages.find(m => m.role === 'system');
    const messages = this.convertMessages(params.messages);

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
    if (params.stop) body.stop_sequences = params.stop;
    if (params.top_p !== undefined) body.top_p = params.top_p;
    if (params.top_k !== undefined) body.top_k = params.top_k;
    if (params.metadata) body.metadata = params.metadata;
    if (params.thinking) body.thinking = params.thinking;
    if (params.service_tier) body.service_tier = params.service_tier;

    // Pass tools through for streaming too
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map(t => {
        if (t.function) {
          return { name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object' } };
        }
        return { name: t.name, description: t.description || '', input_schema: t.input_schema || { type: 'object' } };
      });
      if (params.tool_choice) {
        if (params.tool_choice === 'auto') body.tool_choice = { type: 'auto' };
        else if (params.tool_choice === 'none') body.tool_choice = { type: 'none' };
        else if (params.tool_choice === 'required') body.tool_choice = { type: 'any' };
        else if (typeof params.tool_choice === 'object' && (params.tool_choice as any).function?.name) {
          body.tool_choice = { type: 'tool', name: (params.tool_choice as any).function.name };
        } else {
          body.tool_choice = params.tool_choice;
        }
      }
    }

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

    // Track tool_use blocks being built during streaming
    const pendingToolCalls: Map<number, { id: string; name: string; inputJson: string }> = new Map();

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
            } else if (event.type === 'content_block_start') {
              if (event.content_block?.type === 'tool_use') {
                pendingToolCalls.set(event.index, {
                  id: event.content_block.id || `call_${generateId()}`,
                  name: event.content_block.name,
                  inputJson: '',
                });
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'text_delta' && event.delta.text) {
                yield { id, model, delta: event.delta.text, finish_reason: null };
              } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json !== undefined) {
                const tc = pendingToolCalls.get(event.index);
                if (tc) tc.inputJson += event.delta.partial_json;
              }
            } else if (event.type === 'message_delta') {
              outputTokens = event.usage?.output_tokens || 0;

              // Emit accumulated tool_calls if any
              const toolCalls: ToolCall[] = [];
              for (const tc of pendingToolCalls.values()) {
                toolCalls.push({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.inputJson || '{}' },
                });
              }

              yield {
                id, model, delta: '',
                finish_reason: event.delta?.stop_reason || 'end_turn',
                input_tokens: inputTokens, output_tokens: outputTokens,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
              };
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
