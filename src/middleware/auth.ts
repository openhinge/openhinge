import type { FastifyRequest, FastifyReply } from 'fastify';
import { validateKey } from '../keys/repository.js';
import { AuthError } from '../utils/errors.js';
import type { ApiKey } from '../keys/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKey;
  }
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Support both Bearer token (OpenAI-style) and x-api-key header (Anthropic-style)
  const header = request.headers.authorization;
  const xApiKey = request.headers['x-api-key'] as string | undefined;

  let rawKey = '';
  if (header?.startsWith('Bearer ')) {
    rawKey = header.slice(7);
  } else if (xApiKey) {
    rawKey = xApiKey;
  }

  if (!rawKey) {
    throw new AuthError('Missing API key — use Authorization: Bearer <key> or x-api-key header');
  }

  if (!rawKey.startsWith('ohk_')) {
    throw new AuthError('Invalid key format — must start with ohk_');
  }

  const key = validateKey(rawKey);
  if (!key) {
    throw new AuthError('Invalid, expired, or disabled API key');
  }

  request.apiKey = key;
}
