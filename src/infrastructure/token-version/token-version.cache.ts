import { Injectable } from '@nestjs/common';
import config from '../../common/config/app.config';
import { RedisService } from '../../common/services/redis.service';

/**
 * Optional cache of each user's current token version, in front of
 * `authUser.tokenVersion` (the source of truth). AuthGuard reads it on every
 * request; security events overwrite or drop it so revoked access tokens stop
 * working at once.
 */
export abstract class TokenVersionCache {
  /** The cached version, or null on a miss (or when the cache is unavailable). */
  abstract get(userId: string): Promise<number | null>;

  /**
   * Caches a version read from the database, only if nothing is cached: a
   * concurrent security event may already have published a newer version.
   */
  abstract fill(userId: string, tokenVersion: number): Promise<void>;

  /**
   * Overwrites the cached version after a security event. Throws when the
   * cache cannot confirm the write, so callers can fail closed.
   */
  abstract publish(userId: string, tokenVersion: number): Promise<void>;

  /** Drops the cached version; the next request reloads it from the database. */
  abstract invalidate(userId: string): Promise<void>;
}

/** Seconds a cached version lives without a security event replacing it. */
export const TOKEN_VERSION_CACHE_TTL_SECONDS = 3600;

/**
 * Redis implementation (REDIS_ENABLED=true). The key namespace is versioned:
 * entries written before authentication state moved to PostgreSQL (whose
 * migration incremented every token version) are never read.
 */
@Injectable()
export class RedisTokenVersionCache extends TokenVersionCache {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async get(userId: string): Promise<number | null> {
    const cached = await this.redis.get<number>(this.key(userId));
    return typeof cached === 'number' ? cached : null;
  }

  async fill(userId: string, tokenVersion: number): Promise<void> {
    await this.redis.setNX(
      this.key(userId),
      tokenVersion,
      TOKEN_VERSION_CACHE_TTL_SECONDS,
    );
  }

  async publish(userId: string, tokenVersion: number): Promise<void> {
    const cached = await this.redis.set(
      this.key(userId),
      tokenVersion,
      TOKEN_VERSION_CACHE_TTL_SECONDS,
    );
    if (!cached) {
      throw new Error('The cached token version could not be updated');
    }
  }

  async invalidate(userId: string): Promise<void> {
    await this.redis.del(this.key(userId));
  }

  private key(userId: string): string {
    return `${config.redis_cache_key_prefix}:token_version:v2:${userId}`;
  }
}

/**
 * No cache (REDIS_ENABLED=false): every check reads the database, which is
 * always current, so publishing and invalidating have nothing to do.
 */
@Injectable()
export class NoopTokenVersionCache extends TokenVersionCache {
  get(): Promise<number | null> {
    return Promise.resolve(null);
  }

  fill(): Promise<void> {
    return Promise.resolve();
  }

  publish(): Promise<void> {
    return Promise.resolve();
  }

  invalidate(): Promise<void> {
    return Promise.resolve();
  }
}
