import type { FastifyRequest, FastifyReply } from 'fastify';
import { AuthError } from '../utils/errors.js';

export function adminAuthMiddleware(adminToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ')
      ? header.slice(7)
      : (request.headers['x-admin-token'] as string);

    if (!token || token !== adminToken) {
      throw new AuthError('Invalid admin token');
    }
  };
}
