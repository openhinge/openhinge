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

  private isTokenExpired(): boolean {
    const expiresAt = this.config.credentials.expires_at;
    if (!expiresAt) return false; // unknown expiry — assume valid
    return Date.now() >= Number(expiresAt);
  }

  /**
   * Like OpenClaw: sync credentials from disk on EVERY request.
   * Always pick up the latest accessToken AND refreshToken from the
   * credential store so we never use a stale/rotated token.
   */
  protected override async ensureFreshToken(): Promise<void> {
    if (this.isSubscription) {
      const local = await this.readLocalCredentials();
      if (local?.accessToken) {
        let changed = false;

        // Always sync accessToken
        if (local.accessToken !== this.config.credentials.oauth_token) {
          this.config.credentials.oauth_token = local.accessToken;
          changed = true;
        }
        // Always sync refreshToken (Claude Code may have rotated it)
        if (local.refreshToken && local.refreshToken !== this.config.credentials.refresh_token) {
          this.config.credentials.refresh_token = local.refreshToken;
          changed = true;
        }
        // Always sync expiresAt
        if (local.expiresAt && String(local.expiresAt) !== this.config.credentials.expires_at) {
          this.config.credentials.expires_at = String(local.expiresAt);
          changed = true;
        }

        if (changed) {
          this.persistCredentials();
          logger.info({ id: this.id }, 'Synced credentials from credential store');
        }

        // If the synced token is still valid, we're done
        if (!this.isTokenExpired()) return;

        // Token from credential store is expired — do OAuth refresh with the
        // (potentially fresh) refresh_token we just synced
        logger.info({ id: this.id }, 'Credential store token expired — attempting OAuth refresh');
        await this.doOAuthRefresh();
        return;
      }
    }

    // Non-subscription: expiry-based refresh
    const expiresAt = this.config.credentials.expires_at;
    if (expiresAt) {
      const expiresMs = Number(expiresAt);
      const bufferMs = 5 * 60 * 1000;
      if (Date.now() + bufferMs >= expiresMs) {
        await this.refreshToken();
      }
    }
  }

  private async readLocalCredentials(): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number } | null> {
    try {
      let raw: string | undefined;
      const { platform, homedir } = await import('node:os');
      const { readFileSync, existsSync, readdirSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      if (platform() === 'darwin') {
        const { execSync } = await import('node:child_process');
        try {
          raw = execSync(
            'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim();
        } catch { /* Keychain not available */ }
      }

      if (!raw) {
        const searchPaths: string[] = [];
        if (process.env.CLAUDE_CONFIG_DIR) {
          searchPaths.push(resolve(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'));
        }
        searchPaths.push(resolve(homedir(), '.claude', '.credentials.json'));
        // Windows: %APPDATA%\.claude
        if (process.env.APPDATA) {
          searchPaths.push(resolve(process.env.APPDATA, '.claude', '.credentials.json'));
        }
        // Linux: root and /home/* users
        searchPaths.push('/root/.claude/.credentials.json');
        try { for (const u of readdirSync('/home')) searchPaths.push(`/home/${u}/.claude/.credentials.json`); } catch {}

        for (const p of [...new Set(searchPaths)]) {
          if (existsSync(p)) {
            try { raw = readFileSync(p, 'utf-8'); break; } catch {}
          }
        }
      }

      if (!raw) return null;
      const creds = JSON.parse(raw);
      const oauth = creds.claudeAiOauth;
      if (!oauth?.accessToken) return null;
      return { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt };
    } catch {
      return null;
    }
  }

  private async writeBackToCredentialStore(accessToken: string, refreshToken: string, expiresAt: number): Promise<void> {
    // Write refreshed token back to Claude Code's credential store so both stay in sync
    try {
      const { homedir } = await import('node:os');
      const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      const paths = [
        resolve(homedir(), '.claude', '.credentials.json'),
        '/root/.claude/.credentials.json',
      ];
      if (process.env.APPDATA) {
        paths.push(resolve(process.env.APPDATA, '.claude', '.credentials.json'));
      }

      for (const p of paths) {
        if (!existsSync(p)) continue;
        try {
          const existing = JSON.parse(readFileSync(p, 'utf-8'));
          if (existing.claudeAiOauth) {
            existing.claudeAiOauth.accessToken = accessToken;
            existing.claudeAiOauth.refreshToken = refreshToken;
            existing.claudeAiOauth.expiresAt = expiresAt;
            writeFileSync(p, JSON.stringify(existing, null, 2));
            logger.info({ id: this.id, path: p }, 'Wrote refreshed token back to credential store');
          }
        } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
  }

  /**
   * OAuth refresh_token flow — get a new access token from Anthropic.
   * Also writes back to credential store so Claude Code stays in sync.
   */
  private async doOAuthRefresh(): Promise<boolean> {
    const refreshToken = this.config.credentials.refresh_token;
    const clientId = this.config.credentials.client_id;
    if (!refreshToken || !clientId) {
      logger.debug({ id: this.id }, 'No refresh_token or client_id for OAuth refresh');
      return false;
    }

    try {
      logger.info({ id: this.id }, 'Attempting OAuth token refresh');
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
      const expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : 0;
      if (expiresAt) {
        this.config.credentials.expires_at = String(expiresAt);
      }
      if (data.refresh_token) {
        this.config.credentials.refresh_token = data.refresh_token;
      }

      this.persistCredentials();
      logger.info({ id: this.id }, 'Claude OAuth token refreshed successfully');

      // Write back to credential store so Claude Code stays in sync
      if (data.refresh_token && expiresAt) {
        await this.writeBackToCredentialStore(data.access_token, data.refresh_token, expiresAt);
      }

      return true;
    } catch (err: any) {
      logger.error({ id: this.id, err: err.message }, 'Claude OAuth refresh error');
      return false;
    }
  }

  async refreshToken(): Promise<boolean> {
    // Sync latest credentials from credential store (including refresh_token)
    if (this.isSubscription) {
      const local = await this.readLocalCredentials();
      if (local?.accessToken) {
        if (local.accessToken !== this.config.credentials.oauth_token) {
          this.config.credentials.oauth_token = local.accessToken;
          if (local.refreshToken) this.config.credentials.refresh_token = local.refreshToken;
          if (local.expiresAt) this.config.credentials.expires_at = String(local.expiresAt);
          this.persistCredentials();
          logger.info({ id: this.id }, 'Claude token refreshed from local credentials');
          return true;
        }
        // Same accessToken but sync refresh_token in case it was rotated
        if (local.refreshToken && local.refreshToken !== this.config.credentials.refresh_token) {
          this.config.credentials.refresh_token = local.refreshToken;
          if (local.expiresAt) this.config.credentials.expires_at = String(local.expiresAt);
          this.persistCredentials();
        }
      }
    }

    // OAuth refresh — use the (potentially just-synced) refresh_token
    // For claude_code source: only when token is expired (avoid unnecessary rotation).
    if (this.config.credentials.source === 'claude_code' && !this.isTokenExpired()) {
      return false;
    }

    return this.doOAuthRefresh();
  }

  private convertMessages(msgs: ChatRequest['messages']): any[] {
    const out: any[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
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
        // Tool result — merge consecutive tool messages into one user message
        // Claude requires ALL tool_results in a single user message after tool_use
        const toolResults: any[] = [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }];
        while (i + 1 < msgs.length && msgs[i + 1].role === 'tool' && msgs[i + 1].tool_call_id) {
          i++;
          toolResults.push({ type: 'tool_result', tool_use_id: msgs[i].tool_call_id, content: msgs[i].content });
        }
        out.push({ role: 'user', content: toolResults });
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
