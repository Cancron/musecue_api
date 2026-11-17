import { BullModule } from '@nestjs/bullmq';
import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import config from '../../../common/config/app.config';
import {
  EMAIL_QUEUE,
  MAKEUP_AI_QUEUE,
  makeupAiGlobalConcurrency,
  makeupAiRateLimit,
  PRIVACY_EXPORT_QUEUE,
} from '../job-queues';
import {
  BullMqJobDispatcher,
  BullMqJobInspector,
  BullMqQueues,
} from './bullmq-job.dispatcher';
import {
  EmailBullMqProcessor,
  MakeupAiBullMqProcessor,
  PrivacyExportBullMqProcessor,
} from './bullmq.processors';

/**
 * Applies the makeup AI queue's distributed limits at startup: global
 * concurrency and the provider rate limit, shared by all API instances.
 */
@Injectable()
export class BullMqQueueLimits implements OnModuleInit {
  constructor(
    private readonly queues: BullMqQueues,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queues.get(MAKEUP_AI_QUEUE);
    const rateLimit = makeupAiRateLimit(this.config);
    await Promise.all([
      queue.setGlobalConcurrency(makeupAiGlobalConcurrency(this.config)),
      queue.setGlobalRateLimit(rateLimit.max, rateLimit.durationMs),
    ]);
  }
}

/** BullMQ queue driver: only imported when REDIS_ENABLED=true. */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (env: ConfigService) => ({
        connection: {
          host: env.get<string>('REDIS_HOST') || 'localhost',
          port: parseInt(env.get<string>('REDIS_PORT') || '6379', 10),
          password: env.get<string>('REDIS_PASSWORD'),
          db: parseInt(env.get<string>('REDIS_DB') || '0', 10),
        },
        prefix: `${config.redis_cache_key_prefix}:bull`,
      }),
    }),
    BullModule.registerQueue(
      { name: EMAIL_QUEUE },
      { name: MAKEUP_AI_QUEUE },
      { name: PRIVACY_EXPORT_QUEUE },
    ),
  ],
  providers: [
    BullMqQueues,
    BullMqQueueLimits,
    BullMqJobDispatcher,
    BullMqJobInspector,
    EmailBullMqProcessor,
    MakeupAiBullMqProcessor,
    PrivacyExportBullMqProcessor,
  ],
  exports: [BullMqQueues, BullMqJobDispatcher, BullMqJobInspector],
})
export class BullMqJobsModule {}
