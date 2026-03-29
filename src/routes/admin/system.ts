import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { Config } from '../../config/index.js';
import { savePasswordHash } from '../../config/index.js';
import { getAllProviders } from '../../providers/index.js';
import { getAllSouls } from '../../souls/repository.js';
import { getAllKeys } from '../../keys/repository.js';
import { getDb } from '../../db/index.js';

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

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
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    };
  });

  // Public — check if password is set
  app.get('/admin/auth/status', async () => {
    return {
      hasPassword: !!config.auth.passwordHash,
      hasLegacyToken: !!config.auth.adminToken && !config.auth.passwordHash,
    };
  });

  // Public — verify a stored session token
  app.post('/admin/auth/verify', async (request, reply) => {
    const header = request.headers.authorization;
    const bearerToken = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!bearerToken) return reply.code(401).send({ error: 'No token' });
    if (config.auth.passwordHash && bearerToken === config.auth.passwordHash) return { ok: true };
    if (config.auth.adminToken && bearerToken === config.auth.adminToken) return { ok: true };
    return reply.code(401).send({ error: 'Invalid token' });
  });

  // Public — set password (only works if no password set yet)
  app.post<{ Body: { password: string } }>('/admin/auth/setup', async (request, reply) => {
    const { password } = request.body || {};
    if (!password || password.length < 4) {
      return reply.code(400).send({ error: 'Password must be at least 4 characters' });
    }
    if (config.auth.passwordHash) {
      return reply.code(409).send({ error: 'Password already set. Use change-password instead.' });
    }

    const hash = hashPassword(password);
    config.auth.passwordHash = hash;
    delete config.auth.adminToken; // remove legacy token
    savePasswordHash(hash);

    const providers = getAllProviders().length;
    const soulsList = getAllSouls();
    const keysList = getAllKeys();

    return {
      ok: true,
      token: hash,
      setup: {
        has_providers: providers > 0,
        has_souls: soulsList.length > 0,
        has_keys: keysList.length > 0,
      },
    };
  });

  // Public — login with password (or legacy token)
  app.post<{ Body: { password?: string; token?: string } }>('/admin/auth/login', async (request, reply) => {
    const { password, token } = request.body || {};

    // Password-based login
    if (password && config.auth.passwordHash) {
      const hash = hashPassword(password);
      if (hash !== config.auth.passwordHash) {
        return reply.code(401).send({ error: 'Wrong password' });
      }
      const providers = getAllProviders().length;
      const soulsList = getAllSouls();
      const keysList = getAllKeys();
      return {
        ok: true,
        token: hash,
        setup: {
          has_providers: providers > 0,
          has_souls: soulsList.length > 0,
          has_keys: keysList.length > 0,
        },
      };
    }

    // Legacy token login
    if (token && config.auth.adminToken && token === config.auth.adminToken) {
      const providers = getAllProviders().length;
      const soulsList = getAllSouls();
      const keysList = getAllKeys();
      return {
        ok: true,
        token: config.auth.adminToken,
        setup: {
          has_providers: providers > 0,
          has_souls: soulsList.length > 0,
          has_keys: keysList.length > 0,
        },
      };
    }

    return reply.code(401).send({ error: 'Invalid credentials' });
  });

  // Admin — change password (manual auth check)
  app.post<{ Body: { current_password: string; new_password: string } }>('/admin/auth/change-password', async (request, reply) => {
    const { current_password, new_password } = request.body || {};

    // Verify current credentials
    if (config.auth.passwordHash) {
      if (!current_password || hashPassword(current_password) !== config.auth.passwordHash) {
        return reply.code(401).send({ error: 'Current password is wrong' });
      }
    } else if (config.auth.adminToken) {
      const header = request.headers.authorization;
      const bearerToken = header?.startsWith('Bearer ') ? header.slice(7) : '';
      if (bearerToken !== config.auth.adminToken) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    } else {
      return reply.code(400).send({ error: 'No auth configured — use setup first' });
    }

    if (!new_password || new_password.length < 4) {
      return reply.code(400).send({ error: 'Password must be at least 4 characters' });
    }

    const hash = hashPassword(new_password);
    config.auth.passwordHash = hash;
    delete config.auth.adminToken;
    savePasswordHash(hash);

    return { ok: true, token: hash };
  });

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });
}
