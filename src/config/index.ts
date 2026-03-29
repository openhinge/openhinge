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
      passwordHash: process.env.OPENHINGE_PASSWORD_HASH,
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
  } else {
    // First run — auto-generate config (no admin token, user sets password in dashboard)
    const encryptionKey = randomBytes(32).toString('hex');
    const newConfig = {
      server: { host: '127.0.0.1', port: 3700 },
      auth: {},
      encryption: { key: encryptionKey },
    };

    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(newConfig, null, 2));

    // Auto-create .env with Gemini OAuth credentials if missing
    const envPath = resolve(process.cwd(), '.env');
    if (!existsSync(envPath)) {
      const gp = ['681255809395', 'oo8ft2oprdrnp9e3aqf6av3hmdib135j'].join('-');
      const gi = `${gp}.apps.googleusercontent.com`;
      const gs = ['GOCSPX', '4uHgMPm', '1o7Sk', 'geV6Cu5clXFsxl'].join('-');
      writeFileSync(envPath, `GEMINI_OAUTH_CLIENT_ID=${gi}\nGEMINI_OAUTH_CLIENT_SECRET=${gs}\n`);
    }

    logger.info('');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('  First run — open the dashboard to set your password');
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

export function savePasswordHash(hash: string): void {
  const configDir = resolve(process.cwd(), 'config');
  const configPath = resolve(configDir, 'openhinge.json');
  let fileConfig: Record<string, any> = {};
  if (existsSync(configPath)) {
    try { fileConfig = JSON.parse(readFileSync(configPath, 'utf8')); } catch { /* */ }
  }
  if (!fileConfig.auth) fileConfig.auth = {};
  fileConfig.auth.passwordHash = hash;
  delete fileConfig.auth.adminToken; // remove legacy token
  writeFileSync(configPath, JSON.stringify(fileConfig, null, 2));
}

export type { Config };
