import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
// import { BlogModule } from './blog/blog.module';
import { AuthModule } from './auth/auth.module';
import { MfaModule } from './auth/mfa/mfa.module';
import { StepUpModule } from './auth/step-up/step-up.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { MetricsModule } from './metrics/metrics.module';
import { WinstonModule } from 'nest-winston';
import { winstonConfig } from './common/config/winston.config';
import { LoggerModule } from './common/modules/logger.module';
import { MakeupModule } from './makeup/makeup.module';
import { DatabaseModule } from './common/modules/database.module';
import { ProfileModule } from './profile/profile.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { PrivacyModule } from './privacy/privacy.module';
import { AccountDeletionModule } from './privacy/account-deletion/account-deletion.module';

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
    // Queue, rate-limit and token-version cache drivers selected by
    // REDIS_ENABLED (global): Redis + BullMQ, or PostgreSQL only. Also
    // registers global request rate limiting. Reads the environment when
    // this module is defined, so it must stay after ConfigModule.forRoot(),
    // which loads the env files into process.env.
    InfrastructureModule.forRoot(),
    // Metrics module (global - Prometheus metrics)
    MetricsModule,
    // BlogModule,
    AuthModule,
    MfaModule,
    StepUpModule,
    MakeupModule,
    ProfileModule,
    SubscriptionModule,
    PrivacyModule,
    AccountDeletionModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
