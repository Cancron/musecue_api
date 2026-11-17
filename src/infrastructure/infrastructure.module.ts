import { Global, Module, type DynamicModule } from '@nestjs/common';
import { RedisModule } from '../common/modules/redis.module';
import { RedisService } from '../common/services/redis.service';
import {
  resolveInfrastructureSettings,
  type InfrastructureSettings,
} from './infrastructure.config';
import {
  INFRASTRUCTURE_SETTINGS,
  InfrastructureStartupReport,
} from './infrastructure-startup.report';
import {
  BullMqJobDispatcher,
  BullMqJobInspector,
} from './jobs/bullmq/bullmq-job.dispatcher';
import { BullMqJobsModule } from './jobs/bullmq/bullmq-jobs.module';
import { JobsCoreModule } from './jobs/jobs-core.module';
import { JobDispatcher, JobInspector } from './jobs/job.types';
import {
  PostgresJobDispatcher,
  PostgresJobInspector,
} from './jobs/postgres/postgres-job.dispatcher';
import { PostgresJobStore } from './jobs/postgres/postgres-job.store';
import { PostgresJobWorker } from './jobs/postgres/postgres-job.worker';
import { PostgresRateLimitStore } from './rate-limit/postgres-rate-limit.store';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RateLimitStore } from './rate-limit/rate-limit.store';
import { RedisRateLimitStore } from './rate-limit/redis-rate-limit.store';
import {
  NoopTokenVersionCache,
  RedisTokenVersionCache,
  TokenVersionCache,
} from './token-version/token-version.cache';

const SHARED_EXPORTS = [
  INFRASTRUCTURE_SETTINGS,
  JobDispatcher,
  JobInspector,
  RateLimitStore,
  TokenVersionCache,
];

/**
 * Selects the infrastructure drivers from REDIS_ENABLED, once, at startup.
 *
 * - Redis: Redis client, BullMQ queues and workers, Redis throttler storage,
 *   Redis rate-limit counters and token-version cache.
 * - PostgreSQL: the in-process PostgreSQL job worker, PostgreSQL rate-limit
 *   counters and throttler storage, and no token-version cache. No Redis
 *   module is registered, so no Redis client is ever created.
 *
 * Feature code depends only on the abstractions (JobDispatcher, JobInspector,
 * RateLimitStore, TokenVersionCache) and registers job handlers with the
 * JobHandlerRegistry.
 */
@Global()
@Module({})
export class InfrastructureModule {
  static forRoot(
    settings: InfrastructureSettings = resolveInfrastructureSettings(),
  ): DynamicModule {
    const common = [
      { provide: INFRASTRUCTURE_SETTINGS, useValue: settings },
      PostgresJobStore,
      InfrastructureStartupReport,
    ];
    if (settings.redisEnabled) {
      return {
        module: InfrastructureModule,
        global: true,
        imports: [
          JobsCoreModule,
          RedisModule,
          BullMqJobsModule,
          RateLimitModule.forRoot(settings),
        ],
        providers: [
          ...common,
          RedisService,
          RedisTokenVersionCache,
          RedisRateLimitStore,
          { provide: TokenVersionCache, useExisting: RedisTokenVersionCache },
          { provide: RateLimitStore, useExisting: RedisRateLimitStore },
          { provide: JobDispatcher, useExisting: BullMqJobDispatcher },
          { provide: JobInspector, useExisting: BullMqJobInspector },
        ],
        exports: [...SHARED_EXPORTS, RedisService],
      };
    }
    return {
      module: InfrastructureModule,
      global: true,
      imports: [JobsCoreModule, RateLimitModule.forRoot(settings)],
      providers: [
        ...common,
        NoopTokenVersionCache,
        PostgresRateLimitStore,
        PostgresJobDispatcher,
        PostgresJobInspector,
        PostgresJobWorker,
        { provide: TokenVersionCache, useExisting: NoopTokenVersionCache },
        { provide: RateLimitStore, useExisting: PostgresRateLimitStore },
        { provide: JobDispatcher, useExisting: PostgresJobDispatcher },
        { provide: JobInspector, useExisting: PostgresJobInspector },
      ],
      exports: [...SHARED_EXPORTS, PostgresJobWorker],
    };
  }
}
