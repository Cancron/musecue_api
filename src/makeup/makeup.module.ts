import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { QueueModule } from '../common/modules';
import { RedisService } from '../common/services/redis.service';
import { StorageModule } from '../storage/storage.module';
import { MockAiGateway } from './ai/mock-ai.gateway';
import { MakeupController } from './makeup.controller';
import { MakeupService } from './makeup.service';
import { MakeupProcessor } from './queues/makeup.processor';
import { MakeupQueueService } from './queues/makeup.queue';
import { ImageValidationService } from './services/image-validation.service';

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
    MockAiGateway,
    RedisService,
    AuthGuard,
    ImageValidationService,
  ],
})
export class MakeupModule {}
