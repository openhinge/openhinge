import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/index.js';
import { createServer } from './server.js';
import { closeDatabase } from './db/index.js';
import { logger } from './utils/logger.js';

// Set version from package.json once at startup
const __dirname = dirname(fileURLToPath(import.meta.url));
function findPkg(start: string): string {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    const p = resolve(dir, 'package.json');
    try { readFileSync(p, 'utf-8'); return p; } catch {}
    dir = resolve(dir, '..');
  }
  return resolve(start, '../../package.json');
}
const pkg = JSON.parse(readFileSync(findPkg(__dirname), 'utf-8'));
process.env.OPENHINGE_VERSION = pkg.version;

async function main() {
  logger.info({ version: pkg.version }, 'Starting OpenHinge AI Gateway...');

  const config = loadConfig();
  const server = await createServer(config);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    await server.close();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.listen({ host: config.server.host, port: config.server.port });

  logger.info(`OpenHinge running at http://${config.server.host}:${config.server.port}`);
  logger.info(`Dashboard: http://${config.server.host}:${config.server.port}/dashboard/`);
  logger.info(`Health: http://${config.server.host}:${config.server.port}/health`);
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start OpenHinge');
  process.exit(1);
});
