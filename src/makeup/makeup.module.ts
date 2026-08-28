import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { QueueModule } from '../common/modules';
import { RedisService } from '../common/services/redis.service';
import { MockAiGateway } from './ai/mock-ai.gateway';
import { MakeupController } from './makeup.controller';
import { MakeupService } from './makeup.service';
import { MakeupProcessor } from './queues/makeup.processor';
import { MakeupQueueService } from './queues/makeup.queue';

@Module({
  imports: [QueueModule, BullModule.registerQueue({ name: 'makeup-ai' })],
  controllers: [MakeupController],
  providers: [
    MakeupService,
    MakeupQueueService,
    MakeupProcessor,
    MockAiGateway,
    RedisService,
    AuthGuard,
  ],
})
export class MakeupModule {}
