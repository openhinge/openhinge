import type { FastifyInstance } from 'fastify';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { Config } from '../../config/index.js';
import { savePasswordHash } from '../../config/index.js';
import { getAllProviders } from '../../providers/index.js';
import { getAllSouls } from '../../souls/repository.js';
import { getAllKeys } from '../../keys/repository.js';
import { getDb } from '../../db/index.js';
import { createSession, validateSession, revokeAllSessions } from '../../auth/sessions.js';

// --- Password hashing with scrypt (no external deps) ---

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password: string, stored: string): boolean {
  // Handle legacy SHA256 hashes (plain 64-char hex)
  if (!stored.startsWith('scrypt:')) {
    const legacy = createHash('sha256').update(password).digest('hex');
    return legacy === stored;
  }
  const [, salt, hash] = stored.split(':');
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return timingSafeEqual(derived, expected);
}

function getSetupStatus() {
  return {
    has_providers: getAllProviders().length > 0,
    has_souls: getAllSouls().length > 0,
    has_keys: getAllKeys().length > 0,
  };
}

// --- Rate limiting for login ---
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 60_000; // 1 minute

function checkLoginRate(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_LOGIN_ATTEMPTS;
}

export async function systemAdminRoutes(app: FastifyInstance, config: Config): Promise<void> {
  app.get('/admin/system/status', async () => {
    const db = getDb();
    const totalRequests = (db.prepare('SELECT COUNT(*) as count FROM usage_logs').get() as any).count;
    const todayRequests = (db.prepare("SELECT COUNT(*) as count FROM usage_logs WHERE created_at >= date('now')").get() as any).count;

    return {
      status: 'running',
      version: process.env.OPENHINGE_VERSION || 'dev',
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
    if (validateSession(bearerToken)) return { ok: true };
    return reply.code(401).send({ error: 'Invalid or expired session' });
  });

  // Public — set password (first time only)
  app.post<{ Body: { password: string } }>('/admin/auth/setup', async (request, reply) => {
    const { password } = request.body || {};
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' });
    }
    if (config.auth.passwordHash) {
      return reply.code(409).send({ error: 'Password already set' });
    }

    const hash = hashPassword(password);
    config.auth.passwordHash = hash;
    savePasswordHash(hash);

    const sessionToken = createSession();
    return { ok: true, token: sessionToken, setup: getSetupStatus() };
  });

  // Public — login with password
  app.post<{ Body: { password: string } }>('/admin/auth/login', async (request, reply) => {
    const ip = request.ip;
    if (!checkLoginRate(ip)) {
      return reply.code(429).send({ error: 'Too many login attempts. Try again in a minute.' });
    }

    const { password } = request.body || {};
    if (!password || !config.auth.passwordHash) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    if (!verifyPassword(password, config.auth.passwordHash)) {
      return reply.code(401).send({ error: 'Wrong password' });
    }

    // If legacy SHA256 hash, upgrade to scrypt on successful login
    if (!config.auth.passwordHash.startsWith('scrypt:')) {
      const upgraded = hashPassword(password);
      config.auth.passwordHash = upgraded;
      savePasswordHash(upgraded);
    }

    const sessionToken = createSession();
    return { ok: true, token: sessionToken, setup: getSetupStatus() };
  });

  // Change password (verifies current password)
  app.post<{ Body: { current_password: string; new_password: string } }>('/admin/auth/change-password', async (request, reply) => {
    const { current_password, new_password } = request.body || {};

    if (!config.auth.passwordHash) {
      return reply.code(400).send({ error: 'No password set — use setup first' });
    }
    if (!current_password || !verifyPassword(current_password, config.auth.passwordHash)) {
      return reply.code(401).send({ error: 'Current password is wrong' });
    }
    if (!new_password || new_password.length < 8) {
      return reply.code(400).send({ error: 'New password must be at least 8 characters' });
    }

    const hash = hashPassword(new_password);
    config.auth.passwordHash = hash;
    savePasswordHash(hash);

    // Revoke all existing sessions — force re-login
    revokeAllSessions();
    const sessionToken = createSession();
    return { ok: true, token: sessionToken };
  });

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });
}
