import {
  describeInfrastructure,
  InvalidInfrastructureConfigError,
  parseRedisEnabled,
  resolveInfrastructureSettings,
} from './infrastructure.config';

describe('REDIS_ENABLED configuration', () => {
  describe('parseRedisEnabled', () => {
    it.each([undefined, '', '   '])(
      'defaults to true when omitted or empty (%j)',
      (raw) => {
        expect(parseRedisEnabled(raw)).toBe(true);
      },
    );

    it.each([
      ['true', true],
      ['false', false],
      [' false ', false],
      ['true\n', true],
    ])('accepts %j', (raw, expected) => {
      expect(parseRedisEnabled(raw)).toBe(expected);
    });

    it.each(['TRUE', 'False', '1', '0', 'yes', 'no', 'on', 'off', 'redis'])(
      'rejects %j at startup',
      (raw) => {
        expect(() => parseRedisEnabled(raw)).toThrow(
          InvalidInfrastructureConfigError,
        );
        expect(() => parseRedisEnabled(raw)).toThrow(
          'REDIS_ENABLED must be "true" or "false"',
        );
      },
    );
  });

  describe('resolveInfrastructureSettings', () => {
    it('selects every Redis driver when enabled (and by default)', () => {
      const expected = {
        redisEnabled: true,
        queueDriver: 'bullmq',
        rateLimitDriver: 'redis',
        tokenVersionCache: 'redis',
      };
      expect(resolveInfrastructureSettings({ REDIS_ENABLED: 'true' })).toEqual(
        expected,
      );
      expect(resolveInfrastructureSettings({})).toEqual(expected);
    });

    it('selects every PostgreSQL driver when disabled, without Redis settings', () => {
      expect(
        resolveInfrastructureSettings({
          REDIS_ENABLED: 'false',
          JWT_REFRESH_SECRET: 'refresh-secret',
        }),
      ).toEqual({
        redisEnabled: false,
        queueDriver: 'postgres',
        rateLimitDriver: 'postgres',
        tokenVersionCache: 'none',
      });
    });

    it('requires the refresh secret that keys encrypted job payloads in PostgreSQL mode', () => {
      expect(() =>
        resolveInfrastructureSettings({ REDIS_ENABLED: 'false' }),
      ).toThrow('JWT_REFRESH_SECRET is required when REDIS_ENABLED=false');
      // The legacy shared secret is accepted like everywhere else.
      expect(
        resolveInfrastructureSettings({
          REDIS_ENABLED: 'false',
          JWT_SECRET: 'legacy-secret',
        }).redisEnabled,
      ).toBe(false);
    });

    it('rejects an invalid value', () => {
      expect(() =>
        resolveInfrastructureSettings({ REDIS_ENABLED: 'maybe' }),
      ).toThrow(InvalidInfrastructureConfigError);
    });
  });

  describe('describeInfrastructure', () => {
    const env = {
      REDIS_HOST: 'cache.internal',
      REDIS_PORT: '6380',
      REDIS_USER: 'default',
      REDIS_PASSWORD: 'super-secret-password',
      JWT_REFRESH_SECRET: 'refresh-secret',
    };

    it('names the selected drivers without credentials (Redis)', () => {
      const line = describeInfrastructure(
        resolveInfrastructureSettings({ ...env, REDIS_ENABLED: 'true' }),
        env,
      );
      expect(line).toBe(
        'REDIS_ENABLED=true: queue driver bullmq, rate-limit driver redis, token-version cache redis (Redis at cache.internal:6380)',
      );
      expect(line).not.toContain('super-secret-password');
      expect(line).not.toContain('default');
    });

    it('states that no Redis connection is made (PostgreSQL)', () => {
      const line = describeInfrastructure(
        resolveInfrastructureSettings({ ...env, REDIS_ENABLED: 'false' }),
        env,
      );
      expect(line).toBe(
        'REDIS_ENABLED=false: queue driver postgres, rate-limit driver postgres, token-version cache none (no Redis connection)',
      );
      expect(line).not.toContain('cache.internal');
    });
  });
});
