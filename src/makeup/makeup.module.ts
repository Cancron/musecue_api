import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '../common/guards/auth.guard';
import { QueueModule } from '../common/modules';
import { RedisService } from '../common/services/redis.service';
import { StorageModule } from '../storage/storage.module';
import { MockAiGateway } from './ai/mock-ai.gateway';
import { AI_GATEWAY, type AiGateway } from './ai/ai.gateway';
import { LiveAiGateway } from './ai/live-ai.gateway';
import { OpenRouterProvider } from './ai/providers/openrouter.provider';
import { STRUCTURED_AI_PROVIDER } from './ai/providers/structured-ai.provider';
import { MakeupController } from './makeup.controller';
import { MakeupService } from './makeup.service';
import { MakeupProcessor } from './queues/makeup.processor';
import { MakeupQueueService } from './queues/makeup.queue';
import { ImageValidationService } from './services/image-validation.service';
import { MakeupRecoveryService } from './queues/makeup-recovery.service';

@Module({
  imports: [
    QueueModule,
    StorageModule,
    BullModule.registerQueue({ name: 'makeup-ai' }),
  ],
  controllers: [MakeupController],
  providers: [
    MakeupService,
    MakeupQueueService,
    MakeupProcessor,
    MakeupRecoveryService,
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
    RedisService,
    AuthGuard,
    ImageValidationService,
  ],
})
export class MakeupModule {}
