import { randomBytes } from 'node:crypto';

/**
 * Environment of the Redis-mode e2e tests (REDIS_ENABLED=true with a real
 * Redis from TEST_REDIS_URL). Imported first, before any application module
 * reads the environment. Keys use a unique prefix, removed afterwards.
 */
process.env.NODE_ENV = 'test';
process.env.REDIS_ENABLED = 'true';
process.env.LOKI_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.AI_MODE = 'mock';
process.env.PRIVATE_STORAGE_PROVIDER = 'local';
process.env.JWT_ACCESS_SECRET = 'redis-mode-e2e-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET = 'redis-mode-e2e-refresh-secret-0123456789';
// Dedicated MFA key (32 bytes), independent of the JWT secrets:
// sha256('musecue-e2e-mfa-encryption-key'), as 64 hex characters.
process.env.MFA_ENCRYPTION_KEY =
  'd5286eeda6cc31720c61ca68a4a4b2160f3afb13d70acfc92c6c3bc4bb3feb8d';
process.env.PRIVACY_EXPORT_DOWNLOAD_SECRET =
  'redis-mode-e2e-download-secret-0123456789';
process.env.REDIS_CACHE_KEY_PREFIX = `redis_mode_e2e_${randomBytes(6).toString('hex')}`;
if (process.env.TEST_REDIS_URL) {
  const url = new URL(process.env.TEST_REDIS_URL);
  process.env.REDIS_HOST = url.hostname;
  process.env.REDIS_PORT = url.port || '6379';
  process.env.REDIS_DB = url.pathname.replace('/', '') || '0';
  if (url.username) process.env.REDIS_USER = decodeURIComponent(url.username);
  if (url.password) {
    process.env.REDIS_PASSWORD = decodeURIComponent(url.password);
  } else {
    delete process.env.REDIS_PASSWORD;
  }
}
