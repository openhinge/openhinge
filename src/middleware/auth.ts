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
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new AuthError('Missing Authorization: Bearer <key> header');
  }

  const rawKey = header.slice(7);
  if (!rawKey.startsWith('ohk_')) {
    throw new AuthError('Invalid key format — must start with ohk_');
  }

  const key = validateKey(rawKey);
  if (!key) {
    throw new AuthError('Invalid, expired, or disabled API key');
  }

  request.apiKey = key;
}
