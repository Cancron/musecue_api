import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { Redis as RedisType } from 'ioredis';
import { REDIS_CLIENT } from '../modules/redis.module';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

/**
 * Redis Service - Production-grade caching service
 *
 * Features:
 * - Uses dependency injection for Redis client (shared connection)
 * - SCAN-based pattern deletion (non-blocking, production-safe)
 * - Proper error handling with logging
 * - Health check on module initialization
 * - Type-safe generic methods
 */
@Injectable()
export class RedisService implements OnModuleInit {
  /** Security reads must distinguish infrastructure failure from missing data. */
  async getRequired<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async rotateRefreshToken(input: {
    oldKey: string;
    newKey: string;
    sessionsKey: string;
    expectedHash: string;
    oldJti: string;
    newJti: string;
    newData: unknown;
    ttlSeconds: number;
  }): Promise<boolean> {
    const result: unknown = await this.client.eval(
      `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return 0 end
      local old = cjson.decode(raw)
      if old.tokenHash ~= ARGV[1] then return 0 end
      local sessions = cjson.decode(redis.call('GET', KEYS[3]) or '[]')
      local updated = {}
      for _, jti in ipairs(sessions) do
        if jti ~= ARGV[2] then table.insert(updated, jti) end
      end
      table.insert(updated, ARGV[3])
      redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[5])
      redis.call('SET', KEYS[3], cjson.encode(updated), 'EX', ARGV[5])
      redis.call('DEL', KEYS[1])
      return 1
    `,
      3,
      input.oldKey,
      input.newKey,
      input.sessionsKey,
      input.expectedHash,
      input.oldJti,
      input.newJti,
      JSON.stringify(input.newData),
      input.ttlSeconds,
    );
    return result === 1;
  }

  async updateSessionList(
    key: string,
    jti: string,
    add: boolean,
    ttl: number,
  ): Promise<void> {
    await this.client.eval(
      `
      local sessions = cjson.decode(redis.call('GET', KEYS[1]) or '[]')
      local updated = {}
      for _, value in ipairs(sessions) do
        if value ~= ARGV[1] then table.insert(updated, value) end
      end
      if ARGV[2] == '1' then table.insert(updated, ARGV[1]) end
      if #updated == 0 then redis.call('DEL', KEYS[1])
      else redis.call('SET', KEYS[1], cjson.encode(updated), 'EX', ARGV[3]) end
      return 1
    `,
      1,
      key,
      jti,
      add ? '1' : '0',
      ttl,
    );
  }

  async pruneRefreshSessions(
    key: string,
    tokenPrefix: string,
    maxDevices: number,
    ttl: number,
  ): Promise<void> {
    // Called after login registers its token. maxDevices=0 revokes all sessions.
    await this.client.eval(
      `
      local sessions = cjson.decode(redis.call('GET', KEYS[1]) or '[]')
      local maximum = tonumber(ARGV[2])
      if maximum > 0 and #sessions <= maximum then return 0 end
      local keep = math.max(0, maximum)
      local updated = {}
      for index, jti in ipairs(sessions) do
        if index <= #sessions - keep then redis.call('DEL', ARGV[1] .. jti)
        else table.insert(updated, jti) end
      end
      if #updated == 0 then redis.call('DEL', KEYS[1])
      else redis.call('SET', KEYS[1], cjson.encode(updated), 'EX', ARGV[3]) end
      return 1
    `,
      1,
      key,
      tokenPrefix,
      maxDevices,
      ttl,
    );
  }

  constructor(
    @Inject(REDIS_CLIENT) private readonly client: RedisType,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /**
   * Health check on service initialization
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.ping();
      this.logger.info('Redis health check passed', {
        context: 'RedisService',
      });
    } catch (error) {
      this.logger.error('Redis health check failed', {
        context: 'RedisService',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check Redis connection health
   */
  async ping(): Promise<string> {
    return this.client.ping();
  }

  /**
   * Check if Redis is connected and ready
   */
  isReady(): boolean {
    return this.client.status === 'ready';
  }

  /**
   * Get cached data by key
   * @param key - Cache key
   * @returns Parsed data or null if not found
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.client.get(key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch (error) {
      this.logger.error(`Error getting key "${key}"`, {
        context: 'RedisService',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Set cached data with optional TTL
   * @param key - Cache key
   * @param value - Value to cache (will be JSON stringified)
   * @param ttlSeconds - Time to live in seconds (optional)
   */
  async set(
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<boolean> {
    try {
      const data = JSON.stringify(value);
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.setex(key, ttlSeconds, data);
      } else {
        await this.client.set(key, data);
      }
      return true;
    } catch (error) {
      this.logger.error(`Error setting key "${key}"`, {
        context: 'RedisService',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Set data only if key does not exist (for distributed locks)
   * @param key - Cache key
   * @param value - Value to cache
   * @param ttlSeconds - Time to live in seconds
   * @returns true if key was set, false if key already existed
   */
  async setNX(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<boolean> {
    try {
      const data = JSON.stringify(value);
      const result = await this.client.set(key, data, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (error) {
      this.logger.error(`Error setting NX key "${key}":`, error);
      return false;
    }
  }

  /**
   * Delete a single key
   * @param key - Cache key to delete
   * @returns Number of keys deleted
   */
  async del(key: string): Promise<number> {
    try {
      return await this.client.del(key);
    } catch (error) {
      this.logger.error(`Error deleting key "${key}":`, error);
      return 0;
    }
  }

  /**
   * Delete multiple keys
   * @param keys - Array of cache keys to delete
   * @returns Number of keys deleted
   */
  async delMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    try {
      return await this.client.del(...keys);
    } catch (error) {
      this.logger.error('Error deleting multiple keys:', error);
      return 0;
    }
  }

  /**
   * Delete keys matching a pattern using SCAN (production-safe)
   * Uses SCAN instead of KEYS to avoid blocking Redis
   *
   * @param pattern - Pattern to match (e.g., "user:*", "cache:session:*")
   * @param batchSize - Number of keys to scan per iteration (default: 100)
   * @returns Number of keys deleted
   */
  async deleteByPattern(pattern: string, batchSize = 100): Promise<number> {
    let cursor = '0';
    let totalDeleted = 0;

    try {
      do {
        const [newCursor, keys] = await this.client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          batchSize,
        );
        cursor = newCursor;

        if (keys.length > 0) {
          const deleted = await this.client.del(...keys);
          totalDeleted += deleted;
        }
      } while (cursor !== '0');

      if (totalDeleted > 0) {
        this.logger.debug(`Deleted ${totalDeleted} keys matching "${pattern}"`);
      }

      return totalDeleted;
    } catch (error) {
      this.logger.error(`Error deleting by pattern "${pattern}":`, error);
      return totalDeleted;
    }
  }

  /**
   * Check if a key exists
   * @param key - Cache key
   */
  async exists(key: string): Promise<boolean> {
    try {
      return (await this.client.exists(key)) === 1;
    } catch (error) {
      this.logger.error(`Error checking existence of key "${key}":`, error);
      return false;
    }
  }

  /**
   * Get remaining TTL for a key in seconds
   * @param key - Cache key
   * @returns TTL in seconds, -1 if no TTL, -2 if key doesn't exist
   */
  async ttl(key: string): Promise<number> {
    try {
      return await this.client.ttl(key);
    } catch (error) {
      this.logger.error(`Error getting TTL for key "${key}":`, error);
      return -2;
    }
  }

  /**
   * Set a new TTL on an existing key
   * @param key - Cache key
   * @param ttlSeconds - New TTL in seconds
   */
  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.expire(key, ttlSeconds);
      return result === 1;
    } catch (error) {
      this.logger.error(`Error setting expire for key "${key}":`, error);
      return false;
    }
  }

  /**
   * Increment a numeric value
   * @param key - Cache key
   * @param increment - Amount to increment (default: 1)
   */
  async incr(key: string, increment = 1): Promise<number | null> {
    try {
      if (increment === 1) {
        return await this.client.incr(key);
      }
      return await this.client.incrby(key, increment);
    } catch (error) {
      this.logger.error(`Error incrementing key "${key}":`, error);
      return null;
    }
  }

  /**
   * Hash operations - Set field in hash
   */
  async hset(key: string, field: string, value: unknown): Promise<boolean> {
    try {
      const data = typeof value === 'string' ? value : JSON.stringify(value);
      await this.client.hset(key, field, data);
      return true;
    } catch (error) {
      this.logger.error(`Error hset "${key}.${field}":`, error);
      return false;
    }
  }

  /**
   * Hash operations - Get field from hash
   */
  async hget<T>(key: string, field: string): Promise<T | null> {
    try {
      const data = await this.client.hget(key, field);
      if (!data) return null;
      try {
        return JSON.parse(data) as T;
      } catch {
        return data as T;
      }
    } catch (error) {
      this.logger.error(`Error hget "${key}.${field}":`, error);
      return null;
    }
  }

  /**
   * Hash operations - Get all fields from hash
   */
  async hgetall<T = Record<string, string>>(key: string): Promise<T | null> {
    try {
      const data = await this.client.hgetall(key);
      if (!data || Object.keys(data).length === 0) return null;
      return data as T;
    } catch (error) {
      this.logger.error(`Error hgetall "${key}":`, error);
      return null;
    }
  }

  /**
   * Hash operations - Delete field from hash
   */
  async hdel(key: string, field: string): Promise<boolean> {
    try {
      const result = await this.client.hdel(key, field);
      return result === 1;
    } catch (error) {
      this.logger.error(`Error hdel "${key}.${field}":`, error);
      return false;
    }
  }

  // ==================== Legacy API Compatibility ====================
  // These methods maintain backward compatibility with existing code

  /**
   * @deprecated Use get() instead
   */
  async getCachedData<T>(key: string): Promise<T | null> {
    return this.get<T>(key);
  }

  /**
   * @deprecated Use set() instead
   */
  async cacheData(key: string, value: unknown, ttl: number): Promise<void> {
    await this.set(key, value, ttl);
  }

  /**
   * @deprecated Use deleteByPattern() instead
   */
  async deleteCachedData(pattern: string): Promise<boolean> {
    const deleted = await this.deleteByPattern(pattern);
    return deleted >= 0;
  }

  /**
   * Clear all cached data - USE WITH CAUTION
   * Only for development/testing environments
   */
  async flushAll(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      this.logger.error('flushAll() is disabled in production');
      return;
    }
    await this.client.flushall();
    this.logger.warn('All Redis data has been flushed');
  }
}
