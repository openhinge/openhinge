import { z } from 'zod';

export const configSchema = z.object({
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(3700),
  }).default({}),

  db: z.object({
    path: z.string().default('./data/openhinge.db'),
  }).default({}),

  auth: z.object({
    adminToken: z.string().min(16, 'Admin token must be at least 16 characters'),
  }),

  encryption: z.object({
    key: z.string().min(32, 'Encryption key must be at least 32 characters'),
  }),

  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  }).default({}),

  watchdog: z.object({
    enabled: z.boolean().default(true),
    intervalMs: z.number().int().min(5000).default(60_000),
  }).default({}),

  queue: z.object({
    concurrency: z.number().int().min(1).max(20).default(3),
    pollIntervalMs: z.number().int().min(100).default(1000),
  }).default({}),

  cron: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
});

export type Config = z.infer<typeof configSchema>;
