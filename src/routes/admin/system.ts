import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config/index.js';
import { getAllProviders } from '../../providers/index.js';
import { getAllSouls } from '../../souls/repository.js';
import { getAllKeys } from '../../keys/repository.js';
import { getDb } from '../../db/index.js';

export async function systemAdminRoutes(app: FastifyInstance, config: Config): Promise<void> {
  app.get('/admin/system/status', async () => {
    const db = getDb();
    const totalRequests = (db.prepare('SELECT COUNT(*) as count FROM usage_logs').get() as any).count;
    const todayRequests = (db.prepare("SELECT COUNT(*) as count FROM usage_logs WHERE created_at >= date('now')").get() as any).count;

    return {
      status: 'running',
      version: '0.1.0',
      uptime: process.uptime(),
      providers: getAllProviders().length,
      souls: getAllSouls().length,
      api_keys: getAllKeys().length,
      total_requests: totalRequests,
      today_requests: todayRequests,
      memory: {
        rss: Math.round(process.memoryUsage.rss() / 1024 / 1024),
        heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    };
  });

  // Public — validate admin token (for welcome screen login)
  app.post<{ Body: { token: string } }>('/admin/auth/login', async (request, reply) => {
    const { token } = request.body || {};
    if (!token || token !== config.auth.adminToken) {
      return reply.code(401).send({ error: 'Invalid admin token' });
    }

    const providers = getAllProviders().length;
    const soulsList = getAllSouls();
    const keysList = getAllKeys();

    return {
      ok: true,
      setup: {
        has_providers: providers > 0,
        has_souls: soulsList.length > 0,
        has_keys: keysList.length > 0,
      },
    };
  });

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });
}
