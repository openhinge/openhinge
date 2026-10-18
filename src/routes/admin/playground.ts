import type { FastifyInstance, FastifyReply } from 'fastify';
import { getSoulById } from '../../souls/repository.js';
import { getProvider, providerChainFor, chatWithFallback, streamWithFallback } from '../../providers/index.js';
import type { BaseProvider } from '../../providers/index.js';
import { logUsage } from '../../cost/index.js';
import { calculateCostCents } from '../../utils/tokens.js';
import { generateId } from '../../utils/crypto.js';
import { OpenHingeError } from '../../utils/errors.js';
import type { ChatMessage, ChatRequest, FallbackAttempt } from '../../providers/types.js';
import type { Soul } from '../../souls/types.js';

/** api_key_id recorded in usage_logs for requests sent from the dashboard playground */
export const PLAYGROUND_KEY_ID = 'playground';

export interface PlaygroundBody {
  /** Send to this one provider, with no fallback */
  provider_id?: string;
  /** Or route through this soul, the same way /v1/souls/:slug/chat/completions does */
  soul_id?: string;
  model?: string;
  /** Replaces the soul's system prompt when present ('' sends none) */
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface PlaygroundPlan {
  soul: Soul | null;
  providerIds: string[];
  params: ChatRequest;
}

const ROLES = new Set(['user', 'assistant', 'system']);

function invalid(message: string): OpenHingeError {
  return new OpenHingeError(message, 400, 'INVALID_REQUEST');
}

/** Validate a playground request and work out which providers it goes to */
export function planPlaygroundRequest(body: PlaygroundBody): PlaygroundPlan {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalid('messages must be a non-empty array');
  }
  for (const m of body.messages) {
    if (!m || !ROLES.has(m.role) || typeof m.content !== 'string') {
      throw invalid('Each message needs a role (user, assistant or system) and string content');
    }
  }
  if (body.provider_id && body.soul_id) throw invalid('Pick provider_id or soul_id, not both');
  if (body.temperature != null && !Number.isFinite(body.temperature)) throw invalid('temperature must be a number');
  if (body.max_tokens != null && !(Number.isInteger(body.max_tokens) && body.max_tokens > 0)) {
    throw invalid('max_tokens must be a positive integer');
  }

  let soul: Soul | null = null;
  let providerIds: string[];
  if (body.provider_id) {
    if (!getProvider(body.provider_id)) {
      throw new OpenHingeError('Provider not found or disabled', 404, 'NOT_FOUND');
    }
    providerIds = [body.provider_id];
  } else {
    if (body.soul_id) {
      soul = getSoulById(body.soul_id);
      if (!soul) throw new OpenHingeError('Soul not found', 404, 'NOT_FOUND');
    }
    providerIds = providerChainFor(soul);
  }
  if (providerIds.length === 0) throw new OpenHingeError('No providers configured', 503, 'NO_PROVIDERS');

  const system = body.system ?? soul?.system_prompt;
  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...body.messages.map(m => ({ role: m.role, content: m.content })));

  return {
    soul,
    providerIds,
    params: {
      messages,
      model: body.model?.trim() || soul?.model || undefined,
      temperature: body.temperature ?? soul?.temperature,
      max_tokens: body.max_tokens || soul?.max_tokens,
    },
  };
}

interface Outcome {
  provider?: BaseProvider;
  model: string;
  input_tokens: number;
  output_tokens: number;
  finish_reason: string | null;
  fallback_attempts: FallbackAttempt[];
  latency_ms: number;
  ttft_ms?: number;
}

function describe(requestId: string, o: Outcome) {
  return {
    request_id: requestId,
    provider: o.provider ? { id: o.provider.id, name: o.provider.name } : null,
    model: o.model,
    finish_reason: o.finish_reason,
    usage: { input_tokens: o.input_tokens, output_tokens: o.output_tokens },
    cost_cents: calculateCostCents(o.model, o.input_tokens, o.output_tokens),
    latency_ms: o.latency_ms,
    ttft_ms: o.ttft_ms,
    fallback_attempts: o.fallback_attempts,
  };
}

function record(requestId: string, plan: PlaygroundPlan, o: Outcome, error?: string): void {
  logUsage({
    request_id: requestId,
    api_key_id: PLAYGROUND_KEY_ID,
    soul_id: plan.soul?.id || 'none',
    provider_id: o.provider?.id || 'none',
    model: o.model,
    input_tokens: o.input_tokens,
    output_tokens: o.output_tokens,
    cost_cents: calculateCostCents(o.model, o.input_tokens, o.output_tokens),
    latency_ms: o.latency_ms,
    status: error ? 'error' : 'success',
    error_message: error,
  });
}

export async function playgroundAdminRoutes(app: FastifyInstance): Promise<void> {
  // Models a configured provider offers, for the playground's model picker
  app.get<{ Querystring: { provider_id?: string } }>('/admin/playground/models', async (request) => {
    const provider = getProvider(request.query.provider_id || '');
    if (!provider) throw new OpenHingeError('Provider not found or disabled', 404, 'NOT_FOUND');
    let models: string[] = [];
    try { models = await provider.listModels(); } catch { /* picker falls back to free text */ }
    return { default_model: provider.defaultModel(), models };
  });

  app.post<{ Body: PlaygroundBody }>('/admin/playground/chat', async (request, reply) => {
    const plan = planPlaygroundRequest(request.body);
    const requestId = generateId();
    if (request.body.stream) return streamReply(reply, plan, requestId);

    const start = Date.now();
    try {
      const { provider, response } = await chatWithFallback(plan.providerIds, plan.params);
      const outcome: Outcome = {
        provider,
        model: response.model,
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
        finish_reason: response.finish_reason,
        fallback_attempts: response.fallback_attempts || [],
        latency_ms: Date.now() - start,
      };
      record(requestId, plan, outcome);
      return { content: response.content, ...describe(requestId, outcome) };
    } catch (err: any) {
      record(requestId, plan, {
        model: plan.params.model || 'unknown', input_tokens: 0, output_tokens: 0,
        finish_reason: null, fallback_attempts: [], latency_ms: Date.now() - start,
      }, err.message);
      throw err;
    }
  });
}

/**
 * Stream as server-sent events: {type:'delta',text} per chunk, then one
 * {type:'done',...} with timing and usage, or {type:'error',message}.
 */
async function streamReply(reply: FastifyReply, plan: PlaygroundPlan, requestId: string): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-request-id': requestId,
  });
  const send = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  // The dashboard's Stop button aborts the fetch, which closes the connection
  let stopped = false;
  res.on('close', () => { if (!res.writableFinished) stopped = true; });

  const start = Date.now();
  const outcome: Outcome = {
    model: plan.params.model || 'unknown', input_tokens: 0, output_tokens: 0,
    finish_reason: null, fallback_attempts: [], latency_ms: 0,
  };
  let error: string | undefined;

  try {
    for await (const { provider, chunk, fallback_attempts } of streamWithFallback(plan.providerIds, plan.params)) {
      if (stopped) break;
      outcome.provider = provider;
      if (chunk.model) outcome.model = chunk.model;
      if (fallback_attempts) outcome.fallback_attempts = fallback_attempts;
      if (chunk.delta) {
        outcome.ttft_ms ??= Date.now() - start;
        send({ type: 'delta', text: chunk.delta });
      }
      if (chunk.input_tokens) outcome.input_tokens = chunk.input_tokens;
      if (chunk.output_tokens) outcome.output_tokens = chunk.output_tokens;
      if (chunk.finish_reason) outcome.finish_reason = chunk.finish_reason;
    }
    outcome.latency_ms = Date.now() - start;
    if (!stopped) send({ type: 'done', ...describe(requestId, outcome) });
  } catch (err: any) {
    error = err.message;
    outcome.latency_ms = Date.now() - start;
    if (!stopped) send({ type: 'error', message: err.message, request_id: requestId });
  } finally {
    res.end();
    record(requestId, plan, outcome, error);
  }
}
