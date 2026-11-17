/**
 * REDIS_ENABLED selects the infrastructure drivers once, at startup:
 *
 * - `true` (default when omitted): BullMQ queues, Redis rate limiting and the
 *   Redis token-version cache.
 * - `false`: PostgreSQL queues, PostgreSQL rate limiting and no Redis
 *   connection at all (Redis variables are ignored).
 *
 * PostgreSQL is required in both modes. There is no fallback between drivers
 * after startup.
 */
export const REDIS_ENABLED_ENV = 'REDIS_ENABLED';

export type QueueDriver = 'bullmq' | 'postgres';
export type RateLimitDriver = 'redis' | 'postgres';
export type TokenVersionCacheDriver = 'redis' | 'none';

export interface InfrastructureSettings {
  redisEnabled: boolean;
  queueDriver: QueueDriver;
  rateLimitDriver: RateLimitDriver;
  tokenVersionCache: TokenVersionCacheDriver;
}

export class InvalidInfrastructureConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInfrastructureConfigError';
  }
}

/**
 * Parses REDIS_ENABLED. Only `true` and `false` are accepted (surrounding
 * whitespace is ignored); an omitted or empty value means `true`, so existing
 * deployments keep Redis. Anything else stops the application from starting.
 */
export function parseRedisEnabled(raw: string | undefined): boolean {
  const value = raw?.trim();
  if (value === undefined || value === '') return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new InvalidInfrastructureConfigError(
    `${REDIS_ENABLED_ENV} must be "true" or "false"`,
  );
}

export function resolveInfrastructureSettings(
  env: Record<string, string | undefined> = process.env,
): InfrastructureSettings {
  const redisEnabled = parseRedisEnabled(env[REDIS_ENABLED_ENV]);
  if (!redisEnabled && !env.JWT_REFRESH_SECRET && !env.JWT_SECRET) {
    // PostgreSQL job payloads are encrypted with a key derived from it.
    throw new InvalidInfrastructureConfigError(
      `JWT_REFRESH_SECRET is required when ${REDIS_ENABLED_ENV}=false`,
    );
  }
  return redisEnabled
    ? {
        redisEnabled,
        queueDriver: 'bullmq',
        rateLimitDriver: 'redis',
        tokenVersionCache: 'redis',
      }
    : {
        redisEnabled,
        queueDriver: 'postgres',
        rateLimitDriver: 'postgres',
        tokenVersionCache: 'none',
      };
}

/** A one-line description for the startup log: drivers only, no credentials. */
export function describeInfrastructure(
  settings: InfrastructureSettings,
  env: Record<string, string | undefined> = process.env,
): string {
  const base =
    `${REDIS_ENABLED_ENV}=${String(settings.redisEnabled)}: ` +
    `queue driver ${settings.queueDriver}, ` +
    `rate-limit driver ${settings.rateLimitDriver}, ` +
    `token-version cache ${settings.tokenVersionCache}`;
  if (!settings.redisEnabled) return `${base} (no Redis connection)`;
  const host = env.REDIS_HOST || 'localhost';
  const port = env.REDIS_PORT || '6379';
  return `${base} (Redis at ${host}:${port})`;
}
