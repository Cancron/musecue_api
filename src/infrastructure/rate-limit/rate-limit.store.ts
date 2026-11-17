/** A fixed-window limit: `limit` hits per `windowMs`, then blocked for `blockMs`. */
export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
  blockMs: number;
}

export interface RateLimitResult {
  /** Hits counted in the current window, including this one. */
  totalHits: number;
  /** Milliseconds until the current window ends. */
  windowExpiresInMs: number;
  /** Whether the key is blocked (this hit must be refused). */
  blocked: boolean;
  /** Milliseconds until the block ends (0 when not blocked). */
  blockExpiresInMs: number;
}

/**
 * Rate-limit counters behind the selected driver: Redis when REDIS_ENABLED is
 * true, PostgreSQL otherwise. Used by the custom authentication limits
 * (AuthUtilsService.checkRateLimit) and, with PostgreSQL, by the global
 * request throttler.
 */
export abstract class RateLimitStore {
  /**
   * Counts one hit for `key` atomically and reports whether it exceeds the
   * policy. Throws when the backing store is unavailable.
   */
  abstract hit(key: string, policy: RateLimitPolicy): Promise<RateLimitResult>;

  /** Forgets the counter and block of `key`. */
  abstract reset(key: string): Promise<void>;
}
