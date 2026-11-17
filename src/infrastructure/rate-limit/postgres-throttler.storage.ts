import { Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { RateLimitStore } from './rate-limit.store';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/**
 * @nestjs/throttler storage backed by the selected RateLimitStore (the
 * PostgreSQL store when REDIS_ENABLED=false). The guard passes an already
 * hashed route/tracker key; the store hashes it again before persisting.
 */
@Injectable()
export class RateLimitThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly store: RateLimitStore) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const result = await this.store.hit(`throttler:${throttlerName}:${key}`, {
      limit,
      windowMs: ttl,
      blockMs: blockDuration,
    });
    return {
      totalHits: result.totalHits,
      timeToExpire: Math.ceil(result.windowExpiresInMs / 1000),
      isBlocked: result.blocked,
      timeToBlockExpire: Math.ceil(result.blockExpiresInMs / 1000),
    };
  }
}
