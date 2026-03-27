import { loadConfig } from './config/index.js';
import { createServer } from './server.js';
import { closeDatabase } from './db/index.js';
import { logger } from './utils/logger.js';

async function main() {
  logger.info('Starting OpenHinge AI Gateway...');

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
