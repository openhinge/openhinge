import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { configSchema, type Config } from './schema.js';
import { logger } from '../utils/logger.js';

loadDotenv();

export function loadConfig(): Config {
  // Start with env vars
  const raw: Record<string, unknown> = {
    server: {
      host: process.env.OPENHINGE_HOST,
      port: process.env.OPENHINGE_PORT ? Number(process.env.OPENHINGE_PORT) : undefined,
    },
    db: {
      path: process.env.OPENHINGE_DB_PATH,
    },
    auth: {
      adminToken: process.env.OPENHINGE_ADMIN_TOKEN,
    },
    encryption: {
      key: process.env.OPENHINGE_ENCRYPTION_KEY,
    },
    logging: {
      level: process.env.OPENHINGE_LOG_LEVEL,
    },
  };

  // Merge with JSON config file — auto-create on first run
  const configDir = resolve(process.cwd(), 'config');
  const configPath = resolve(configDir, 'openhinge.json');

  if (existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      deepMerge(raw, fileConfig);
    } catch (err) {
      logger.warn({ err, path: configPath }, 'Failed to parse config file, using env only');
    }
  } else if (!process.env.OPENHINGE_ADMIN_TOKEN) {
    // First run — auto-generate config
    const adminToken = randomBytes(24).toString('hex');
    const encryptionKey = randomBytes(32).toString('hex');
    const newConfig = {
      server: { host: '127.0.0.1', port: 3700 },
      auth: { adminToken },
      encryption: { key: encryptionKey },
    };

    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(newConfig, null, 2));

    logger.info('');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('  First run detected — config auto-generated');
    logger.info('');
    logger.info(`  Admin token: ${adminToken}`);
    logger.info('');
    logger.info('  Paste this token in the dashboard to log in.');
    logger.info('  Saved to config/openhinge.json');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('');

    deepMerge(raw, newConfig);
  }

  // Strip undefined values before validation
  stripUndefined(raw);

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid config:\n  ${issues.join('\n  ')}`);
  }

  return result.data;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined && source[key] !== null) {
      if (typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key] || typeof target[key] !== 'object') {
          target[key] = {};
        }
        deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
      } else {
        target[key] = source[key];
      }
    }
  }
}

function stripUndefined(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) {
      delete obj[key];
    } else if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      stripUndefined(obj[key] as Record<string, unknown>);
      if (Object.keys(obj[key] as object).length === 0) {
        delete obj[key];
      }
    }
  }
}

export type { Config };
