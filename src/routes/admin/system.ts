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

function getSetupStatus() {
  return {
    has_providers: getAllProviders().length > 0,
    has_souls: getAllSouls().length > 0,
    has_keys: getAllKeys().length > 0,
  };
}

export async function systemAdminRoutes(app: FastifyInstance, config: Config): Promise<void> {
  app.get('/admin/system/status', async () => {
    const db = getDb();
    const totalRequests = (db.prepare('SELECT COUNT(*) as count FROM usage_logs').get() as any).count;
    const todayRequests = (db.prepare("SELECT COUNT(*) as count FROM usage_logs WHERE created_at >= date('now')").get() as any).count;

    return {
      status: 'running',
      version: '0.1.4',
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
    return { hasPassword: !!config.auth.passwordHash };
  });

  // Public — verify a stored session token
  app.post('/admin/auth/verify', async (request, reply) => {
    const header = request.headers.authorization;
    const bearerToken = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!bearerToken) return reply.code(401).send({ error: 'No token' });
    if (config.auth.passwordHash && bearerToken === config.auth.passwordHash) return { ok: true };
    return reply.code(401).send({ error: 'Invalid token' });
  });

  // Public — set password (first time only)
  app.post<{ Body: { password: string } }>('/admin/auth/setup', async (request, reply) => {
    const { password } = request.body || {};
    if (!password || password.length < 4) {
      return reply.code(400).send({ error: 'Password must be at least 4 characters' });
    }
    if (config.auth.passwordHash) {
      return reply.code(409).send({ error: 'Password already set' });
    }

    const hash = hashPassword(password);
    config.auth.passwordHash = hash;
    savePasswordHash(hash);

    return { ok: true, token: hash, setup: getSetupStatus() };
  });

  // Public — login with password
  app.post<{ Body: { password: string } }>('/admin/auth/login', async (request, reply) => {
    const { password } = request.body || {};
    if (!password || !config.auth.passwordHash) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const hash = hashPassword(password);
    if (hash !== config.auth.passwordHash) {
      return reply.code(401).send({ error: 'Wrong password' });
    }

    return { ok: true, token: hash, setup: getSetupStatus() };
  });

  // Change password (verifies current password)
  app.post<{ Body: { current_password: string; new_password: string } }>('/admin/auth/change-password', async (request, reply) => {
    const { current_password, new_password } = request.body || {};

    if (!config.auth.passwordHash) {
      return reply.code(400).send({ error: 'No password set — use setup first' });
    }
    if (!current_password || hashPassword(current_password) !== config.auth.passwordHash) {
      return reply.code(401).send({ error: 'Current password is wrong' });
    }
    if (!new_password || new_password.length < 4) {
      return reply.code(400).send({ error: 'New password must be at least 4 characters' });
    }

    const hash = hashPassword(new_password);
    config.auth.passwordHash = hash;
    savePasswordHash(hash);

    return { ok: true, token: hash };
  });

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });
}
