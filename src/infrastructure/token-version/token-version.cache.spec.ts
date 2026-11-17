import { mock } from 'jest-mock-extended';
import config from '../../common/config/app.config';
import type { RedisService } from '../../common/services/redis.service';
import {
  NoopTokenVersionCache,
  RedisTokenVersionCache,
  type TokenVersionCache,
} from './token-version.cache';

describe('TokenVersionCache', () => {
  describe('Redis (REDIS_ENABLED=true)', () => {
    const redis = mock<RedisService>();
    const cache = new RedisTokenVersionCache(redis);
    const key = `${config.redis_cache_key_prefix}:token_version:v2:user-1`;

    beforeEach(() => jest.resetAllMocks());

    it('reads a versioned key, so entries cached before the migration are ignored', async () => {
      redis.get.mockResolvedValue(3 as never);
      await expect(cache.get('user-1')).resolves.toBe(3);
      expect(redis.get.mock.calls).toContainEqual([key]);
    });

    it('reports a miss for absent or malformed entries', async () => {
      redis.get.mockResolvedValue(null);
      await expect(cache.get('user-1')).resolves.toBeNull();
      redis.get.mockResolvedValue('3' as never);
      await expect(cache.get('user-1')).resolves.toBeNull();
    });

    it('fills only an empty entry, for one hour', async () => {
      await cache.fill('user-1', 2);
      expect(redis.setNX.mock.calls).toContainEqual([key, 2, 3600]);
    });

    it('publishes security events and fails closed when Redis cannot confirm', async () => {
      redis.set.mockResolvedValue(true);
      await cache.publish('user-1', 4);
      expect(redis.set.mock.calls).toContainEqual([key, 4, 3600]);

      redis.set.mockResolvedValue(false);
      await expect(cache.publish('user-1', 5)).rejects.toThrow(
        'could not be updated',
      );
    });

    it('invalidates by deleting the entry', async () => {
      await cache.invalidate('user-1');
      expect(redis.del.mock.calls).toContainEqual([key]);
    });
  });

  describe('none (REDIS_ENABLED=false)', () => {
    it('always misses and accepts every write, so AuthGuard reads the database', async () => {
      const cache: TokenVersionCache = new NoopTokenVersionCache();
      await cache.fill('user-1', 2);
      await cache.publish('user-1', 3);
      await cache.invalidate('user-1');
      await expect(cache.get('user-1')).resolves.toBeNull();
    });
  });
});
