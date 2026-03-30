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
import type { ChatMessage } from '../../providers/types.js';

interface AnthropicBody {
  model?: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  system?: string | Array<{ type: string; text: string }>;
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
  stop_sequences?: string[];
}

export async function messagesRoutes(app: FastifyInstance): Promise<void> {
  // Anthropic-compatible endpoint
  app.post<{ Body: AnthropicBody }>('/v1/messages', {
    preHandler: [authMiddleware, rateLimitMiddleware, budgetCheckMiddleware],
  }, handleMessages);

  // Soul-specific Anthropic endpoint
  app.post<{ Params: { slug: string }; Body: AnthropicBody }>('/v1/souls/:slug/messages', {
    preHandler: [authMiddleware, rateLimitMiddleware, budgetCheckMiddleware],
  }, handleMessages);
}

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content.filter(b => b.type === 'text').map(b => b.text || '').join('');
}

function extractSystemText(system: AnthropicBody['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

async function handleMessages(
  request: FastifyRequest<{ Params?: { slug?: string }; Body: AnthropicBody }>,
  reply: FastifyReply,
): Promise<void> {
  const requestId = generateId();
  const msgId = `msg_${requestId}`;
  const start = Date.now();
  const key = request.apiKey!;
  const body = request.body;

  // Resolve soul
  let soul = null;
  const slugParam = (request.params as any)?.slug;
  if (slugParam) {
    soul = getSoulBySlug(slugParam);
  } else if (key.soul_ids && key.soul_ids.length === 1) {
    soul = getSoulById(key.soul_ids[0]);
  } else if (key.soul_id) {
    soul = getSoulById(key.soul_id);
  } else {
    const soulHeader = request.headers['x-openhinge-soul'] as string;
    if (soulHeader) soul = getSoulBySlug(soulHeader);
  }

  if (soul && key.soul_ids && key.soul_ids.length > 0 && !key.soul_ids.includes(soul.id)) {
    throw new OpenHingeError('Key does not have access to this soul', 403, 'SOUL_ACCESS_DENIED');
  }

  // Convert Anthropic format to internal format
  const messages: ChatMessage[] = [];

  // System prompt: soul's system_prompt takes priority, then request's system field
  const systemText = soul?.system_prompt || extractSystemText(body.system);
  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }

  for (const msg of body.messages) {
    messages.push({
      role: msg.role as 'user' | 'assistant',
      content: extractTextContent(msg.content),
    });
  }

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

  const chatParams = {
    messages,
    model: body.model || soul?.model || undefined,
    temperature: body.temperature ?? soul?.temperature,
    max_tokens: body.max_tokens || soul?.max_tokens || 4096,
    stop: body.stop_sequences,
  };

  if (body.stream) {
    // Anthropic SSE streaming format
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
    let contentBlockStarted = false;

    // message_start event
    reply.raw.write(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: chatParams.model || 'unknown',
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`);

    try {
      for await (const { provider, chunk } of streamWithFallback(providerIds, chatParams)) {
        usedProvider = provider.id;
        usedModel = chunk.model;

        if (!contentBlockStarted) {
          // content_block_start
          reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })}\n\n`);
          contentBlockStarted = true;
        }

        if (chunk.delta) {
          reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: chunk.delta },
          })}\n\n`);
        }

        if (chunk.input_tokens) totalInput = chunk.input_tokens;
        if (chunk.output_tokens) totalOutput = chunk.output_tokens;

        if (chunk.finish_reason) {
          // content_block_stop
          reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: 0,
          })}\n\n`);

          // message_delta
          reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: mapStopReason(chunk.finish_reason) },
            usage: { output_tokens: totalOutput },
          })}\n\n`);
        }
      }

      // message_stop
      reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    } catch (err: any) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: err.message },
      })}\n\n`);
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

  // Non-streaming Anthropic response
  try {
    const { provider, response } = await chatWithFallback(providerIds, chatParams);
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

    reply.send({
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: response.content }],
      model: response.model,
      stop_reason: mapStopReason(response.finish_reason),
      stop_sequence: null,
      usage: {
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
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

function mapStopReason(reason: string): string {
  // Normalize various stop reasons to Anthropic format
  if (!reason) return 'end_turn';
  const r = reason.toLowerCase();
  if (r === 'stop' || r === 'end_turn' || r === 'end') return 'end_turn';
  if (r === 'length' || r === 'max_tokens') return 'max_tokens';
  if (r.includes('stop')) return 'stop_sequence';
  return 'end_turn';
}
