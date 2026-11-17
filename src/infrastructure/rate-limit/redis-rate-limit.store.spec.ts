import { mock } from 'jest-mock-extended';
import config from '../../common/config/app.config';
import type { RedisService } from '../../common/services/redis.service';
import { RedisRateLimitStore } from './redis-rate-limit.store';

describe('RedisRateLimitStore (REDIS_ENABLED=true)', () => {
  const redis = mock<RedisService>();
  const store = new RedisRateLimitStore(redis);
  const counter = `${config.redis_cache_key_prefix}:rate_limit:login:ip:203.0.113.1`;

  beforeEach(() => jest.resetAllMocks());

  it('keeps the original counter and lock keys and runs atomically', async () => {
    redis.runScript.mockResolvedValue([1, 900_000, 0, 0]);

    await expect(
      store.hit('login:ip:203.0.113.1', {
        limit: 5,
        windowMs: 900_000,
        blockMs: 900_000,
      }),
    ).resolves.toEqual({
      totalHits: 1,
      windowExpiresInMs: 900_000,
      blocked: false,
      blockExpiresInMs: 0,
    });
    const [, keys, args] = redis.runScript.mock.calls[0];
    expect(keys).toEqual([counter, `${counter}:locked`]);
    expect(args).toEqual([900_000, 5, 900_000]);
  });

  it('reports a locked key', async () => {
    redis.runScript.mockResolvedValue([6, 1_000, 1, 899_000]);
    await expect(
      store.hit('login:ip:203.0.113.1', {
        limit: 5,
        windowMs: 900_000,
        blockMs: 900_000,
      }),
    ).resolves.toMatchObject({ blocked: true, blockExpiresInMs: 899_000 });
  });

  it('throws when Redis fails, so callers decide the policy', async () => {
    redis.runScript.mockRejectedValue(new Error('offline'));
    await expect(
      store.hit('k', { limit: 1, windowMs: 1, blockMs: 1 }),
    ).rejects.toThrow('offline');
  });

  it('resets both keys', async () => {
    await store.reset('login:ip:203.0.113.1');
    expect(redis.delMany.mock.calls).toContainEqual([
      [counter, `${counter}:locked`],
    ]);
  });
});
