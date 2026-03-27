export const defaults = {
  server: {
    host: '127.0.0.1',
    port: 3700,
  },
  db: {
    path: './data/openhinge.db',
  },
  auth: {
    adminToken: '',
  },
  encryption: {
    key: '',
  },
  logging: {
    level: 'info',
  },
  watchdog: {
    enabled: true,
    intervalMs: 60_000,
  },
  queue: {
    concurrency: 3,
    pollIntervalMs: 1000,
  },
  cron: {
    enabled: true,
  },
} as const;
