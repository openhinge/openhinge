import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../../middleware/auth.js';
import { rateLimitMiddleware } from '../../middleware/rate-limit.js';
import { budgetCheckMiddleware } from '../../middleware/budget-check.js';
import { getSoulBySlug, getSoulById } from '../../souls/repository.js';
import { getProvider, getDefaultProvider, chatWithFallback, streamWithFallback } from '../../providers/index.js';
import { logUsage } from '../../cost/index.js';
import { calculateCostCents } from '../../utils/tokens.js';
import { generateId } from '../../utils/crypto.js';
import { NotFoundError, OpenHingeError } from '../../utils/errors.js';
import type { ChatMessage, JsonSchema } from '../../providers/types.js';

/** Lightweight JSON Schema validator — checks type, required fields, and property types */
function validateBasicSchema(data: unknown, schema: JsonSchema): boolean {
  if (schema.type === 'object') {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
    const obj = data as Record<string, unknown>;
    // Check required fields
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) return false;
      }
    }
    // Check property types
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj && propSchema && typeof propSchema === 'object' && 'type' in propSchema) {
          const ps = propSchema as JsonSchema;
          if (ps.type === 'string' && typeof obj[key] !== 'string') return false;
          if (ps.type === 'number' && typeof obj[key] !== 'number') return false;
          if (ps.type === 'integer' && (typeof obj[key] !== 'number' || !Number.isInteger(obj[key]))) return false;
          if (ps.type === 'boolean' && typeof obj[key] !== 'boolean') return false;
          if (ps.type === 'array' && !Array.isArray(obj[key])) return false;
          if (ps.type === 'object' && (typeof obj[key] !== 'object' || obj[key] === null || Array.isArray(obj[key]))) return false;
        }
      }
    }
    return true;
  }
  if (schema.type === 'array') return Array.isArray(data);
  if (schema.type === 'string') return typeof data === 'string';
  if (schema.type === 'number') return typeof data === 'number';
  if (schema.type === 'boolean') return typeof data === 'boolean';
  return true;
}

interface ChatBody {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string[];
  response_schema?: JsonSchema;
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // OpenAI-compatible endpoint
  app.post<{ Body: ChatBody }>('/v1/chat/completions', {
    preHandler: [authMiddleware, rateLimitMiddleware, budgetCheckMiddleware],
  }, handleChat);

  // Soul-specific endpoint
  app.post<{ Params: { slug: string }; Body: ChatBody }>('/v1/souls/:slug/chat/completions', {
    preHandler: [authMiddleware, rateLimitMiddleware, budgetCheckMiddleware],
  }, handleChat);
}

async function handleChat(request: FastifyRequest<{ Params?: { slug?: string }; Body: ChatBody }>, reply: FastifyReply): Promise<void> {
  const requestId = generateId();
  const start = Date.now();
  const key = request.apiKey!;
  const body = request.body;

  // Resolve soul
  let soul = null;
  const slugParam = (request.params as any)?.slug;
  if (slugParam) {
    soul = getSoulBySlug(slugParam);
  } else if (key.soul_ids && key.soul_ids.length === 1) {
    // Single soul binding — auto-resolve
    soul = getSoulById(key.soul_ids[0]);
  } else if (key.soul_id) {
    soul = getSoulById(key.soul_id);
  } else {
    // Check x-openhinge-soul header
    const soulHeader = request.headers['x-openhinge-soul'] as string;
    if (soulHeader) {
      soul = getSoulBySlug(soulHeader);
    }
  }

  // Check soul access if key has soul bindings
  if (soul && key.soul_ids && key.soul_ids.length > 0 && !key.soul_ids.includes(soul.id)) {
    throw new OpenHingeError('Key does not have access to this soul', 403, 'SOUL_ACCESS_DENIED');
  }

  // Build messages with soul's system prompt
  const messages: ChatMessage[] = [];
  if (soul?.system_prompt) {
    messages.push({ role: 'system', content: soul.system_prompt });
  }
  messages.push(...body.messages);

  // Build provider chain
  const providerIds: string[] = [];
  if (soul?.provider_id) providerIds.push(soul.provider_id);
  if (soul?.fallback_chain) providerIds.push(...soul.fallback_chain);
  const defaultProvider = getDefaultProvider();
  if (defaultProvider && !providerIds.includes(defaultProvider.id)) {
    providerIds.push(defaultProvider.id);
  }

  if (providerIds.length === 0) {
    throw new OpenHingeError('No providers configured', 503, 'NO_PROVIDERS');
  }

  // Resolve response schema: request body overrides soul config
  let responseSchema: JsonSchema | undefined;
  if (body.response_schema) {
    responseSchema = body.response_schema;
  } else if (soul?.response_schema) {
    try { responseSchema = JSON.parse(soul.response_schema); } catch { /* invalid schema stored */ }
  }

  const chatParams = {
    messages,
    model: body.model || soul?.model || undefined,
    temperature: body.temperature ?? soul?.temperature,
    max_tokens: body.max_tokens ?? soul?.max_tokens,
    stream: body.stream,
    stop: body.stop,
    response_schema: responseSchema,
  };

  if (body.stream) {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-request-id': requestId,
    });

    let totalInput = 0;
    let totalOutput = 0;
    let usedProvider = '';
    let usedModel = '';

    try {
      for await (const { provider, chunk } of streamWithFallback(providerIds, chatParams)) {
        usedProvider = provider.id;
        usedModel = chunk.model;

        // OpenAI-compatible SSE format
        const sseData = {
          id: `chatcmpl-${chunk.id}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: chunk.model,
          choices: [{
            index: 0,
            delta: chunk.delta ? { content: chunk.delta } : {},
            finish_reason: chunk.finish_reason,
          }],
        };

        reply.raw.write(`data: ${JSON.stringify(sseData)}\n\n`);

        if (chunk.input_tokens) totalInput = chunk.input_tokens;
        if (chunk.output_tokens) totalOutput = chunk.output_tokens;
      }

      reply.raw.write('data: [DONE]\n\n');
    } catch (err: any) {
      reply.raw.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    } finally {
      reply.raw.end();

      logUsage({
        request_id: requestId,
        api_key_id: key.id,
        soul_id: soul?.id || 'none',
        provider_id: usedProvider,
        model: usedModel,
        input_tokens: totalInput,
        output_tokens: totalOutput,
        cost_cents: calculateCostCents(usedModel, totalInput, totalOutput),
        latency_ms: Date.now() - start,
        status: 'success',
      });
    }

    return;
  }

  // Non-streaming
  try {
    const { provider, response } = await chatWithFallback(providerIds, chatParams);

    // Validate structured output if schema was requested
    let schemaValid: boolean | undefined;
    if (responseSchema && response.content) {
      try {
        const parsed = JSON.parse(response.content);
        schemaValid = validateBasicSchema(parsed, responseSchema);
      } catch {
        schemaValid = false;
      }
    }

    const costCents = calculateCostCents(response.model, response.input_tokens, response.output_tokens);

    logUsage({
      request_id: requestId,
      api_key_id: key.id,
      soul_id: soul?.id || 'none',
      provider_id: provider.id,
      model: response.model,
      input_tokens: response.input_tokens,
      output_tokens: response.output_tokens,
      cost_cents: costCents,
      latency_ms: Date.now() - start,
      status: 'success',
    });

    // OpenAI-compatible response format
    reply.send({
      id: `chatcmpl-${response.id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: response.content },
        finish_reason: response.finish_reason,
      }],
      usage: {
        prompt_tokens: response.input_tokens,
        completion_tokens: response.output_tokens,
        total_tokens: response.input_tokens + response.output_tokens,
      },
      _openhinge: {
        request_id: requestId,
        soul: soul?.slug || null,
        provider: provider.name,
        cost_cents: costCents,
        schema_valid: schemaValid,
        fallback_attempts: response.fallback_attempts || undefined,
      },
    });
  } catch (err: any) {
    logUsage({
      request_id: requestId,
      api_key_id: key.id,
      soul_id: soul?.id || 'none',
      provider_id: 'none',
      model: chatParams.model || 'unknown',
      input_tokens: 0,
      output_tokens: 0,
      cost_cents: 0,
      latency_ms: Date.now() - start,
      status: 'error',
      error_message: err.message,
    });
    throw err;
  }
}
