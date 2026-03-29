import type { FastifyRequest, FastifyReply } from 'fastify';
import { AuthError } from '../utils/errors.js';

export function adminAuthMiddleware(getAuth: () => { passwordHash?: string; adminToken?: string }) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ')
      ? header.slice(7)
      : (request.headers['x-admin-token'] as string);

    if (!token) throw new AuthError('Missing auth token');

    const { passwordHash, adminToken } = getAuth();

    // Password mode: token must match the stored hash
    if (passwordHash && token === passwordHash) return;

    // Legacy mode: token must match the old admin token
    if (adminToken && token === adminToken) return;

    // No auth configured yet — block everything
    if (!passwordHash && !adminToken) {
      throw new AuthError('No password set — open the dashboard to set one');
    }

    throw new AuthError('Invalid credentials');
  };
}
