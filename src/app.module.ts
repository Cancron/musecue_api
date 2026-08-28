import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
// import { BlogModule } from './blog/blog.module';
import { AuthModule } from './auth/auth.module';
import { RedisModule } from './common/modules/redis.module';
import { RateLimitModule } from './common/modules/rate-limit.module';
import { MetricsModule } from './metrics/metrics.module';
import { WinstonModule } from 'nest-winston';
import { winstonConfig } from './common/config/winston.config';
import { LoggerModule } from './common/modules/logger.module';
import { MakeupModule } from './makeup/makeup.module';
import { DatabaseModule } from './common/modules/database.module';

@Module({
  imports: [
    // Load environment variables globally
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // Winston logger module (global - can be injected anywhere)
    WinstonModule.forRoot(winstonConfig),
    // Custom logger module (global - can be injected anywhere)
    LoggerModule,
    DatabaseModule,
    // Redis module (global - can be injected anywhere)
    RedisModule,
    // Rate limiting module (global - throttles requests using Redis)
    RateLimitModule,
    // Metrics module (global - Prometheus metrics)
    MetricsModule,
    // BlogModule,
    AuthModule,
    MakeupModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
