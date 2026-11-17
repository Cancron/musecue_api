import { Injectable } from '@nestjs/common';
import config from '../../common/config/app.config';
import { RedisService } from '../../common/services/redis.service';
import {
  RateLimitStore,
  type RateLimitPolicy,
  type RateLimitResult,
} from './rate-limit.store';

/**
 * Lock first: a locked key is refused without counting. Otherwise the hit is
 * counted (the window starts with the first hit) and exceeding the limit
 * locks the key for the block duration. Same keys and semantics as the
 * original INCR/EXPIRE implementation, now applied atomically.
 */
const HIT_SCRIPT = `
local lockTtl = redis.call('PTTL', KEYS[2])
if lockTtl ~= -2 then
  local current = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
  return { current, math.max(redis.call('PTTL', KEYS[1]), 0), 1, math.max(lockTtl, 0) }
end
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '"1"', 'PX', ARGV[3])
  return { hits, ttl, 1, tonumber(ARGV[3]) }
end
return { hits, ttl, 0, 0 }
`;

/** Redis rate-limit counters (REDIS_ENABLED=true). */
@Injectable()
export class RedisRateLimitStore extends RateLimitStore {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async hit(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const raw = await this.redis.runScript(
      HIT_SCRIPT,
      [this.counterKey(key), this.lockKey(key)],
      [
        Math.max(1, Math.ceil(policy.windowMs)),
        policy.limit,
        Math.max(1, Math.ceil(policy.blockMs)),
      ],
    );
    if (!Array.isArray(raw) || raw.length !== 4) {
      throw new TypeError('Unexpected rate-limit script result');
    }
    const [totalHits, windowMs, blocked, blockMs] = raw.map(Number);
    return {
      totalHits,
      windowExpiresInMs: windowMs,
      blocked: blocked === 1,
      blockExpiresInMs: blocked === 1 ? blockMs : 0,
    };
  }

  async reset(key: string): Promise<void> {
    await this.redis.delMany([this.counterKey(key), this.lockKey(key)]);
  }

  private counterKey(key: string): string {
    return `${config.redis_cache_key_prefix}:rate_limit:${key}`;
  }

  private lockKey(key: string): string {
    return `${this.counterKey(key)}:locked`;
  }
}
