import { Module, Global } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { THROTTLER_CONFIG } from '../config/throttler.config';
import { CustomThrottlerGuard } from '../guards/custom-throttler.guard';

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      useFactory: (configService: ConfigService) => {
        // Create Redis client for throttler storage
        const redisClient = new Redis({
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          username: configService.get<string>('REDIS_USER'),
          password: configService.get<string>('REDIS_PASSWORD'),
          db: configService.get<number>('REDIS_DB', 0),
          keyPrefix: `${configService.get<string>('REDIS_CACHE_KEY_PREFIX', 'app')}:throttle:`,
        });

        return {
          // Register one global throttler. Route-level @Throttle decorators
          // override this named `default` policy where a different limit is
          // appropriate. Registering STRICT/AUTH/RELAXED here as additional
          // named throttlers would make every request pass every policy and
          // would therefore impose the 5-per-15-minute auth limit globally.
          throttlers: [
            {
              name: 'default',
              ttl: THROTTLER_CONFIG.DEFAULT.ttl,
              limit: THROTTLER_CONFIG.DEFAULT.limit,
            },
          ],
          storage: new ThrottlerStorageRedisService(redisClient),
        };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [
    // Apply custom rate limiting globally to all routes
    // This guard skips Swagger, metrics, and other infrastructure endpoints
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
  ],
  exports: [ThrottlerModule],
})
export class RateLimitModule {}
