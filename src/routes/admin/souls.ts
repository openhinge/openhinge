import type { FastifyInstance } from 'fastify';
import * as souls from '../../souls/repository.js';

export async function soulAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/souls', async () => {
    return { data: souls.getAllSouls() };
  });

  app.get<{ Params: { id: string } }>('/admin/souls/:id', async (request) => {
    const soul = souls.getSoulById(request.params.id);
    if (!soul) return { error: 'Not found' };
    return { data: soul };
  });

  app.post<{ Body: any }>('/admin/souls', async (request, reply) => {
    const soul = souls.createSoul(request.body as any);
    reply.code(201).send({ data: soul });
  });

  app.put<{ Params: { id: string }; Body: any }>('/admin/souls/:id', async (request) => {
    const soul = souls.updateSoul(request.params.id, request.body as any);
    return { data: soul };
  });

  app.delete<{ Params: { id: string } }>('/admin/souls/:id', async (request) => {
    const ok = souls.deleteSoul(request.params.id);
    return { ok };
  });
}
