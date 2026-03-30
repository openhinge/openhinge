import type { FastifyRequest, FastifyReply } from 'fastify';
import { AuthError } from '../utils/errors.js';
import { validateSession } from '../auth/sessions.js';

export function adminAuthMiddleware(getAuth: () => { passwordHash?: string }) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ')
      ? header.slice(7)
      : (request.headers['x-admin-token'] as string);

    if (!token) throw new AuthError('Missing auth token');

    const { passwordHash } = getAuth();
    if (!passwordHash) throw new AuthError('No password set — open the dashboard to set one');

    if (!validateSession(token)) throw new AuthError('Invalid or expired session');
  };
}
