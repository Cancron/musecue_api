import {
  Global,
  Module,
  type DynamicModule,
  type Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getStorageToken } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { mock, mockDeep } from 'jest-mock-extended';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { REDIS_CLIENT, RedisModule } from '../common/modules/redis.module';
import { PrismaService } from '../common/services/prisma.service';
import { RedisService } from '../common/services/redis.service';
import {
  resolveInfrastructureSettings,
  type InfrastructureSettings,
} from './infrastructure.config';
import { InfrastructureModule } from './infrastructure.module';
import { BullMqJobsModule } from './jobs/bullmq/bullmq-jobs.module';
import {
  BullMqJobDispatcher,
  BullMqJobInspector,
} from './jobs/bullmq/bullmq-job.dispatcher';
import { JobHandlerRegistry } from './jobs/job-handler.registry';
import { JobDispatcher, JobInspector } from './jobs/job.types';
import {
  PostgresJobDispatcher,
  PostgresJobInspector,
} from './jobs/postgres/postgres-job.dispatcher';
import { PostgresJobWorker } from './jobs/postgres/postgres-job.worker';
import { PostgresRateLimitStore } from './rate-limit/postgres-rate-limit.store';
import { RateLimitThrottlerStorage } from './rate-limit/postgres-throttler.storage';
import { RateLimitStore } from './rate-limit/rate-limit.store';
import { RedisRateLimitStore } from './rate-limit/redis-rate-limit.store';
import {
  NoopTokenVersionCache,
  RedisTokenVersionCache,
  TokenVersionCache,
} from './token-version/token-version.cache';

const POSTGRES: InfrastructureSettings = resolveInfrastructureSettings({
  REDIS_ENABLED: 'false',
  JWT_REFRESH_SECRET: 'infrastructure-module-spec',
});
const REDIS: InfrastructureSettings = resolveInfrastructureSettings({
  REDIS_ENABLED: 'true',
});

/** Maps each abstraction to the implementation a dynamic module selects. */
function selected(module: DynamicModule): Map<unknown, unknown> {
  const map = new Map<unknown, unknown>();
  for (const provider of module.providers ?? []) {
    const entry = provider as Provider & {
      provide?: unknown;
      useExisting?: unknown;
    };
    if (entry.provide && entry.useExisting) {
      map.set(entry.provide, entry.useExisting);
    }
  }
  return map;
}

describe('InfrastructureModule (REDIS_ENABLED branches)', () => {
  describe('REDIS_ENABLED=true', () => {
    const module = InfrastructureModule.forRoot(REDIS);

    it('registers Redis, BullMQ and the Redis throttler', () => {
      expect(module.global).toBe(true);
      expect(module.imports).toEqual(
        expect.arrayContaining([RedisModule, BullMqJobsModule]),
      );
      expect(module.providers).toEqual(expect.arrayContaining([RedisService]));
    });

    it('selects the Redis and BullMQ implementations', () => {
      const map = selected(module);
      expect(map.get(TokenVersionCache)).toBe(RedisTokenVersionCache);
      expect(map.get(RateLimitStore)).toBe(RedisRateLimitStore);
      expect(map.get(JobDispatcher)).toBe(BullMqJobDispatcher);
      expect(map.get(JobInspector)).toBe(BullMqJobInspector);
      expect(module.providers).not.toEqual(
        expect.arrayContaining([PostgresJobWorker]),
      );
    });
  });

  describe('REDIS_ENABLED=false', () => {
    const module = InfrastructureModule.forRoot(POSTGRES);

    it('registers no Redis, BullMQ or Redis throttler module', () => {
      expect(module.imports).not.toEqual(expect.arrayContaining([RedisModule]));
      expect(module.imports).not.toEqual(
        expect.arrayContaining([BullMqJobsModule]),
      );
      expect(module.providers).not.toEqual(
        expect.arrayContaining([RedisService]),
      );
    });

    it('selects the PostgreSQL implementations and no token-version cache', () => {
      const map = selected(module);
      expect(map.get(TokenVersionCache)).toBe(NoopTokenVersionCache);
      expect(map.get(RateLimitStore)).toBe(PostgresRateLimitStore);
      expect(map.get(JobDispatcher)).toBe(PostgresJobDispatcher);
      expect(map.get(JobInspector)).toBe(PostgresJobInspector);
    });

    describe('compiled application graph', () => {
      const prisma = mockDeep<PrismaService>();
      const connect = jest.spyOn(Redis.prototype, 'connect');

      @Global()
      @Module({
        providers: [
          { provide: PrismaService, useValue: prisma },
          {
            provide: ConfigService,
            useValue: new ConfigService({ NODE_ENV: 'test' }),
          },
          { provide: WINSTON_MODULE_PROVIDER, useValue: mock<Logger>() },
        ],
        exports: [PrismaService, ConfigService, WINSTON_MODULE_PROVIDER],
      })
      class TestCoreModule {}

      afterAll(() => connect.mockRestore());

      it('detects Redis connection attempts (control)', async () => {
        connect.mockClear();
        const client = new Redis({
          host: '127.0.0.1',
          port: 1,
          retryStrategy: () => null,
          maxRetriesPerRequest: 0,
        });
        client.on('error', () => undefined);
        expect(connect).toHaveBeenCalled();
        client.disconnect();
        await new Promise((resolve) => setImmediate(resolve));
      });

      it('starts without constructing or connecting any Redis client', async () => {
        connect.mockClear();
        prisma.infrastructureJob.count.mockResolvedValue(0);
        // The PostgreSQL worker polls as soon as the application is up.
        prisma.$transaction.mockImplementation(((
          callback: (tx: PrismaService) => Promise<unknown>,
        ) => callback(prisma)) as never);
        prisma.$queryRaw.mockResolvedValue([]);
        prisma.infrastructureJob.deleteMany.mockResolvedValue({ count: 0 });
        const moduleRef = await Test.createTestingModule({
          imports: [TestCoreModule, InfrastructureModule.forRoot(POSTGRES)],
        }).compile();
        const app = moduleRef.createNestApplication();
        await app.init();
        try {
          expect(connect).not.toHaveBeenCalled();
          expect(() =>
            moduleRef.get<unknown>(REDIS_CLIENT, { strict: false }),
          ).toThrow();
          expect(() =>
            moduleRef.get(RedisService, { strict: false }),
          ).toThrow();
          expect(moduleRef.get(TokenVersionCache)).toBeInstanceOf(
            NoopTokenVersionCache,
          );
          expect(moduleRef.get(RateLimitStore)).toBeInstanceOf(
            PostgresRateLimitStore,
          );
          expect(moduleRef.get(JobDispatcher)).toBeInstanceOf(
            PostgresJobDispatcher,
          );
          expect(moduleRef.get(JobInspector)).toBeInstanceOf(
            PostgresJobInspector,
          );
          expect(moduleRef.get(JobHandlerRegistry)).toBeInstanceOf(
            JobHandlerRegistry,
          );
          // Request throttling is stored in PostgreSQL.
          expect(
            moduleRef.get(getStorageToken(), { strict: false }),
          ).toBeInstanceOf(RateLimitThrottlerStorage);
          // The worker started polling on its own (even with NODE_ENV=test):
          // it looked for expired leases and due jobs in PostgreSQL.
          const worker = moduleRef.get(PostgresJobWorker);
          expect(worker).toBeInstanceOf(PostgresJobWorker);
          await new Promise((resolve) => setImmediate(resolve));
          expect(prisma.$queryRaw.mock.calls.length).toBeGreaterThan(0);
        } finally {
          await app.close();
        }
        expect(connect).not.toHaveBeenCalled();
      });
    });
  });
});
