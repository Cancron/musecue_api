/**
 * Environment of the PostgreSQL-only e2e tests. Imported first, before any
 * application module reads the environment. Redis points at a closed port:
 * the application must never try to reach it.
 */
process.env.NODE_ENV = 'test';
process.env.REDIS_ENABLED = 'false';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1';
process.env.REDIS_PASSWORD = 'must-never-be-used';
process.env.LOKI_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.AI_MODE = 'mock';
process.env.PRIVATE_STORAGE_PROVIDER = 'local';
process.env.JWT_ACCESS_SECRET = 'postgres-mode-e2e-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET = 'postgres-mode-e2e-refresh-secret-0123456789';
process.env.PRIVACY_EXPORT_DOWNLOAD_SECRET =
  'postgres-mode-e2e-download-secret-0123456789';
