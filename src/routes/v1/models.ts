import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../middleware/auth.js';
import { getAllProviders } from '../../providers/index.js';

export async function modelsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/models', { preHandler: [authMiddleware] }, async (request, reply) => {
    const providers = getAllProviders();
    const models: any[] = [];

    for (const provider of providers) {
      try {
        const providerModels = await provider.listModels();
        for (const model of providerModels) {
          models.push({
            id: model,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: provider.type,
            _openhinge: { provider_id: provider.id, provider_name: provider.name },
          });
        }
      } catch { /* skip unavailable */ }
    }

    reply.send({ object: 'list', data: models });
  });
}
