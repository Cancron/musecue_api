import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '../common/guards/auth.guard';
import { QueueModule } from '../common/modules';
import { MAKEUP_AI_QUEUE } from '../infrastructure/jobs/job-queues';
import { registerJobHandler } from '../infrastructure/jobs/job-handler.registry';
import { StorageModule } from '../storage/storage.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { CreditsModule } from '../credits/credits.module';
import { MakeupCreditService } from './makeup-credit.service';
import { MakeupUsageController } from './makeup-usage.controller';
import { MockAiGateway } from './ai/mock-ai.gateway';
import { AI_GATEWAY, type AiGateway } from './ai/ai.gateway';
import { LiveAiGateway } from './ai/live-ai.gateway';
import { OpenRouterProvider } from './ai/providers/openrouter.provider';
import { STRUCTURED_AI_PROVIDER } from './ai/providers/structured-ai.provider';
import { MakeupController } from './makeup.controller';
import { MakeupService } from './makeup.service';
import { MakeupJobHandler } from './queues/makeup-job.handler';
import { MakeupQueueService } from './queues/makeup.queue';
import { ImageValidationService } from './services/image-validation.service';
import { MakeupRecoveryService } from './queues/makeup-recovery.service';

@Module({
  // SubscriptionModule: ProAccessGuard (credit eligibility for POST /v1/sessions).
  // CreditsModule: AI usage metering and credit deductions.
  imports: [QueueModule, StorageModule, SubscriptionModule, CreditsModule],
  controllers: [MakeupController, MakeupUsageController],
  providers: [
    MakeupService,
    MakeupQueueService,
    MakeupJobHandler,
    registerJobHandler(MAKEUP_AI_QUEUE, MakeupJobHandler),
    MakeupRecoveryService,
    MakeupCreditService,
    MockAiGateway,
    OpenRouterProvider,
    { provide: STRUCTURED_AI_PROVIDER, useExisting: OpenRouterProvider },
    LiveAiGateway,
    {
      provide: AI_GATEWAY,
      inject: [ConfigService, MockAiGateway, LiveAiGateway],
      useFactory: (
        config: ConfigService,
        mockGateway: MockAiGateway,
        liveGateway: LiveAiGateway,
      ): AiGateway => {
        const configuredMode = config.get<string>('AI_MODE');
        const mode =
          configuredMode ??
          (config.get<string>('NODE_ENV') === 'test' ? 'mock' : 'live');
        if (mode === 'mock') return mockGateway;
        if (mode === 'live') {
          liveGateway.validateConfiguration();
          return liveGateway;
        }
        throw new Error('AI_MODE must be either "mock" or "live"');
      },
    },
    AuthGuard,
    ImageValidationService,
  ],
})
export class MakeupModule {}
