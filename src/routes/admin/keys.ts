import type { FastifyInstance } from 'fastify';
import * as keys from '../../keys/repository.js';

export async function keyAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/keys', async () => {
    return { data: keys.getAllKeys() };
  });

  app.post<{ Body: any }>('/admin/keys', async (request, reply) => {
    try {
      const key = keys.createKey(request.body as any);
      // Return the raw key only on creation — store it now, it won't be shown again
      reply.code(201).send({ data: key });
    } catch (err: any) {
      request.log.error({ err: err.message, body: request.body }, 'Key creation failed');
      reply.code(500).send({ error: { code: 'KEY_CREATE_ERROR', message: err.message } });
    }
  });

  app.delete<{ Params: { id: string } }>('/admin/keys/:id', async (request) => {
    const ok = keys.deleteKey(request.params.id);
    return { ok };
  });

  app.post<{ Params: { id: string } }>('/admin/keys/:id/revoke', async (request) => {
    const ok = keys.revokeKey(request.params.id);
    return { ok };
  });

  app.post<{ Params: { id: string } }>('/admin/keys/:id/reactivate', async (request) => {
    const ok = keys.reactivateKey(request.params.id);
    return { ok };
  });
}
