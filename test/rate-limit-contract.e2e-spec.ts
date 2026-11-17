import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  Throttle,
  ThrottlerModule,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { mock } from 'jest-mock-extended';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
import config from '../src/common/config/app.config';
import { AllExceptionsFilter } from '../src/common/filters/all-exception.filter';
import { CustomThrottlerGuard } from '../src/common/guards/custom-throttler.guard';
import type { PrismaService } from '../src/common/services/prisma.service';
import { RedisService } from '../src/common/services/redis.service';
import { PostgresRateLimitStore } from '../src/infrastructure/rate-limit/postgres-rate-limit.store';
import { RateLimitThrottlerStorage } from '../src/infrastructure/rate-limit/postgres-throttler.storage';
import type { RateLimitStore } from '../src/infrastructure/rate-limit/rate-limit.store';
import { RedisRateLimitStore } from '../src/infrastructure/rate-limit/redis-rate-limit.store';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  connectToSchema,
  createSchema,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import {
  TEST_REDIS_URL,
  deleteKeysWithPrefix,
  redisOptions,
} from './support/test-redis';

jest.setTimeout(60_000);

const WINDOW_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const uniqueKey = () => randomBytes(8).toString('hex');

interface Driver {
  /** The global request throttler's storage. */
  throttler: ThrottlerStorage;
  /** The store behind the custom authentication limits. */
  store: RateLimitStore;
  /** Every raw value persisted by the driver (to check what is stored). */
  persisted(): Promise<string>;
  close(): Promise<void>;
}

async function postgresDriver(): Promise<Driver> {
  const schema = await createSchema();
  await applyMigrations(schema, migrationNames());
  const client = new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString: TEST_DATABASE_URL as string,
        options: `-c search_path=${schema}`,
      },
      { schema },
    ),
  });
  const store = new PostgresRateLimitStore(
    client as unknown as PrismaService,
    new ConfigService({ NODE_ENV: 'test' }),
    mock<Logger>(),
  );
  return {
    throttler: new RateLimitThrottlerStorage(store),
    store,
    persisted: async () => {
      const pg = await connectToSchema(schema);
      try {
        const { rows } = await pg.query('SELECT * FROM "RateLimitBucket"');
        return JSON.stringify(rows);
      } finally {
        await pg.end();
      }
    },
    close: async () => {
      await client.$disconnect();
      await dropSchema(schema);
    },
  };
}

function redisDriver(prefix: string): Driver {
  const client = new Redis(redisOptions());
  const throttlerClient = new Redis({
    ...redisOptions(),
    keyPrefix: `${prefix}:throttle:`,
  });
  return {
    throttler: new ThrottlerStorageRedisService(throttlerClient),
    store: new RedisRateLimitStore(new RedisService(client, mock<Logger>())),
    persisted: async () => {
      const keys = await client.keys(`*${prefix}*`);
      return JSON.stringify(keys);
    },
    close: async () => {
      await deleteKeysWithPrefix(prefix);
      await Promise.all([client.quit(), throttlerClient.quit()]);
    },
  };
}

const drivers: Array<[string, boolean]> = [
  ['PostgreSQL', Boolean(TEST_DATABASE_URL)],
  ['Redis', Boolean(TEST_REDIS_URL)],
];

describe.each(drivers)(
  'Rate limiting contract: %s driver',
  (name, available) => {
    const run = available ? describe : describe.skip;

    run('same limit scenarios', () => {
      let driver: Driver;
      const originalPrefix = config.redis_cache_key_prefix;
      const originalSecret = config.jwt_refresh_secret;
      const prefix = `rl_e2e_${uniqueKey()}`;

      beforeAll(async () => {
        config.redis_cache_key_prefix = prefix;
        config.jwt_refresh_secret = 'rate-limit-contract-refresh-secret';
        driver =
          name === 'PostgreSQL' ? await postgresDriver() : redisDriver(prefix);
      });

      afterAll(async () => {
        await driver?.close();
        config.redis_cache_key_prefix = originalPrefix;
        config.jwt_refresh_secret = originalSecret;
      });

      describe('request throttler storage', () => {
        const hit = (key: string, throttlerName = 'default') =>
          driver.throttler.increment(
            key,
            WINDOW_MS,
            3,
            WINDOW_MS,
            throttlerName,
          );

        it('counts hits in a fixed window and blocks past the limit', async () => {
          const key = uniqueKey();
          for (const expected of [1, 2, 3]) {
            await expect(hit(key)).resolves.toEqual({
              totalHits: expected,
              timeToExpire: 1,
              isBlocked: false,
              timeToBlockExpire: 0,
            });
          }
          await expect(hit(key)).resolves.toMatchObject({
            totalHits: 4,
            isBlocked: true,
            timeToBlockExpire: 1,
          });
          // Still blocked while the block lasts.
          await expect(hit(key)).resolves.toMatchObject({ isBlocked: true });
        });

        it('keeps keys and throttlers independent', async () => {
          const key = uniqueKey();
          for (let index = 0; index < 4; index += 1) await hit(key);

          await expect(hit(uniqueKey())).resolves.toMatchObject({
            totalHits: 1,
            isBlocked: false,
          });
          await expect(hit(key, 'auth')).resolves.toMatchObject({
            totalHits: 1,
            isBlocked: false,
          });
        });

        it('allows requests again once the window and block have passed', async () => {
          const key = uniqueKey();
          for (let index = 0; index < 4; index += 1) await hit(key);

          await sleep(WINDOW_MS + 300);

          await expect(hit(key)).resolves.toEqual({
            totalHits: 1,
            timeToExpire: 1,
            isBlocked: false,
            timeToBlockExpire: 0,
          });
        });
      });

      describe('HTTP routes', () => {
        let app: INestApplication<App>;

        @Controller('limited')
        class LimitedController {
          @Get()
          @Throttle({ default: { ttl: 60_000, limit: 2 } })
          get() {
            return { ok: true };
          }
        }

        beforeAll(async () => {
          @Module({
            imports: [
              ThrottlerModule.forRoot({
                throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
                storage: driver.throttler,
              }),
            ],
            controllers: [LimitedController],
            providers: [{ provide: APP_GUARD, useClass: CustomThrottlerGuard }],
          })
          class LimitedModule {}
          const moduleRef = await Test.createTestingModule({
            imports: [LimitedModule],
          }).compile();
          app = moduleRef.createNestApplication();
          app.useGlobalFilters(new AllExceptionsFilter(mock<Logger>()));
          await app.init();
        });

        afterAll(async () => {
          await app?.close();
        });

        it('applies route limits with the same error response', async () => {
          const http = () =>
            request(app.getHttpServer())
              .get('/limited')
              .set('X-Forwarded-For', '198.51.100.1');
          await http().expect(200);
          await http().expect(200);
          const limited = await http().expect(429);

          const { timestamp, ...body } = limited.body as Record<
            string,
            unknown
          >;
          expect(typeof timestamp).toBe('string');
          expect(body).toEqual({
            success: false,
            statusCode: 429,
            message: 'ThrottlerException: Too Many Requests',
            error: 'ThrottlerException',
            path: '/limited',
          });
          expect(limited.headers['retry-after']).toBe('60');
        });
      });

      describe('authentication limits (AuthUtilsService.checkRateLimit)', () => {
        let utils: AuthUtilsService;
        beforeAll(() => {
          utils = new AuthUtilsService(driver.store);
        });

        it('allows the limit, then refuses with 429 for the window', async () => {
          const key = `login:email:${uniqueKey()}@example.com`;
          for (let index = 0; index < 3; index += 1) {
            await expect(utils.checkRateLimit(key, 3, WINDOW_MS)).resolves.toBe(
              true,
            );
          }
          for (let index = 0; index < 2; index += 1) {
            await expect(
              utils.checkRateLimit(key, 3, WINDOW_MS),
            ).rejects.toMatchObject({
              status: 429,
              message: 'Rate limit exceeded. Please try again after 1 seconds.',
            });
          }
          // Other identifiers are unaffected.
          await expect(
            utils.checkRateLimit(`login:ip:${uniqueKey()}`, 3, WINDOW_MS),
          ).resolves.toBe(true);

          await sleep(WINDOW_MS + 300);
          await expect(utils.checkRateLimit(key, 3, WINDOW_MS)).resolves.toBe(
            true,
          );
        });

        it('forgets a limit on reset', async () => {
          const key = `login:email:${uniqueKey()}@example.com`;
          for (let index = 0; index < 4; index += 1) {
            await utils.checkRateLimit(key, 3, 60_000).catch(() => undefined);
          }
          await expect(
            utils.checkRateLimit(key, 3, 60_000),
          ).rejects.toMatchObject({ status: 429 });

          await utils.resetRateLimit(key);

          await expect(utils.checkRateLimit(key, 3, 60_000)).resolves.toBe(
            true,
          );
        });

        it(
          name === 'PostgreSQL'
            ? 'stores identifiers only as keyed hashes'
            : 'keeps the original Redis key layout',
          async () => {
            const email = `${uniqueKey()}@example.com`;
            await utils.checkRateLimit(`login:email:${email}`, 3, 60_000);

            const persisted = await driver.persisted();
            if (name === 'PostgreSQL') {
              expect(persisted).not.toContain(email);
              expect(persisted).toMatch(/"keyHash":"[0-9a-f]{64}"/);
            } else {
              expect(persisted).toContain(
                `${prefix}:rate_limit:login:email:${email}`,
              );
            }
          },
        );
      });
    });
  },
);
