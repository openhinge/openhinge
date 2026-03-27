import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Config } from './config/index.js';
import { logger } from './utils/logger.js';
import { OpenHingeError } from './utils/errors.js';
import { initDatabase } from './db/index.js';
import { loadProviders } from './providers/index.js';
import { adminAuthMiddleware } from './middleware/admin-auth.js';

// Routes
import { chatRoutes } from './routes/v1/chat.js';
import { modelsRoutes } from './routes/v1/models.js';
import { providerAdminRoutes } from './routes/admin/providers.js';
import { soulAdminRoutes } from './routes/admin/souls.js';
import { keyAdminRoutes } from './routes/admin/keys.js';
import { costAdminRoutes } from './routes/admin/cost.js';
import { systemAdminRoutes } from './routes/admin/system.js';
import { settingsAdminRoutes } from './routes/admin/settings.js';

export async function createServer(config: Config) {
  // Init database
  initDatabase(config.db.path);

  // Load providers
  loadProviders(config.encryption.key);

  // Create Fastify instance
  const app = Fastify({
    logger: false, // We use our own pino logger
    disableRequestLogging: true,
  });

  // CORS
  await app.register(cors, { origin: true });

  // Request logging
  app.addHook('onResponse', (request, reply, done) => {
    if (request.url !== '/health') {
      logger.info({
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      }, 'request');
    }
    done();
  });

  // Error handler
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof OpenHingeError) {
      reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    } else {
      logger.error({ err: error, url: request.url }, 'Unhandled error');
      reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
    }
  });

  // Public routes (API key auth)
  await app.register(chatRoutes);
  await app.register(modelsRoutes);

  // Admin routes (admin token auth)
  const adminAuth = adminAuthMiddleware(config.auth.adminToken);
  await app.register(async (adminApp) => {
    adminApp.addHook('preHandler', adminAuth);
    await adminApp.register((r) => providerAdminRoutes(r, config));
    await adminApp.register(soulAdminRoutes);
    await adminApp.register(keyAdminRoutes);
    await adminApp.register(costAdminRoutes);
    await adminApp.register(settingsAdminRoutes);
  });

  // System routes (health is public, status requires admin)
  await app.register((r) => systemAdminRoutes(r, config));

  // Root redirect to dashboard
  app.get('/', async (request, reply) => {
    reply.redirect('/dashboard/');
  });

  // Dashboard static files
  const dashboardPath = resolve(process.cwd(), 'dashboard');
  if (existsSync(dashboardPath)) {
    await app.register(fastifyStatic, {
      root: dashboardPath,
      prefix: '/dashboard/',
    });
  }

  return app;
}
