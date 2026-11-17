import {
  Global,
  Inject,
  Injectable,
  Module,
  OnModuleDestroy,
  type DynamicModule,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule, type ThrottlerOptions } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { THROTTLER_CONFIG } from '../../common/config/throttler.config';
import { CustomThrottlerGuard } from '../../common/guards/custom-throttler.guard';
import type { InfrastructureSettings } from '../infrastructure.config';
import { RateLimitThrottlerStorage } from './postgres-throttler.storage';
import { RateLimitStore } from './rate-limit.store';

/**
 * One global throttler. Route-level @Throttle decorators override this named
 * `default` policy where a different limit is appropriate. Registering
 * STRICT/AUTH/RELAXED here as additional named throttlers would make every
 * request pass every policy and would therefore impose the 5-per-15-minute
 * auth limit globally.
 */
const THROTTLERS: ThrottlerOptions[] = [
  {
    name: 'default',
    ttl: THROTTLER_CONFIG.DEFAULT.ttl,
    limit: THROTTLER_CONFIG.DEFAULT.limit,
  },
];

export const THROTTLER_REDIS_CLIENT = Symbol('THROTTLER_REDIS_CLIENT');

/** Closes the throttler's own Redis connection on shutdown. */
@Injectable()
class ThrottlerRedisConnection implements OnModuleDestroy {
  constructor(@Inject(THROTTLER_REDIS_CLIENT) private readonly client: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}

/** The throttler's Redis connection (REDIS_ENABLED=true only). */
@Global()
@Module({
  providers: [
    {
      provide: THROTTLER_REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        new Redis({
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          username: configService.get<string>('REDIS_USER'),
          password: configService.get<string>('REDIS_PASSWORD'),
          db: configService.get<number>('REDIS_DB', 0),
          keyPrefix: `${configService.get<string>('REDIS_CACHE_KEY_PREFIX', 'app')}:throttle:`,
        }),
    },
    ThrottlerRedisConnection,
  ],
  exports: [THROTTLER_REDIS_CLIENT],
})
class ThrottlerRedisModule {}

/**
 * Global request rate limiting with the selected storage: Redis
 * (@nest-lab/throttler-storage-redis, unchanged) when REDIS_ENABLED=true,
 * otherwise the PostgreSQL RateLimitStore. Route limits and error responses
 * are the same in both modes.
 */
@Module({})
export class RateLimitModule {
  static forRoot(settings: InfrastructureSettings): DynamicModule {
    const throttler =
      settings.rateLimitDriver === 'redis'
        ? ThrottlerModule.forRootAsync({
            imports: [ThrottlerRedisModule],
            inject: [THROTTLER_REDIS_CLIENT],
            useFactory: (client: Redis) => ({
              throttlers: THROTTLERS,
              storage: new ThrottlerStorageRedisService(client),
            }),
          })
        : ThrottlerModule.forRootAsync({
            inject: [RateLimitStore],
            useFactory: (store: RateLimitStore) => ({
              throttlers: THROTTLERS,
              storage: new RateLimitThrottlerStorage(store),
            }),
          });
    return {
      module: RateLimitModule,
      global: true,
      imports: [throttler],
      providers: [
        // Apply rate limiting globally; the guard skips Swagger, metrics and
        // other infrastructure endpoints.
        { provide: APP_GUARD, useClass: CustomThrottlerGuard },
      ],
      exports: [ThrottlerModule],
    };
  }
}
