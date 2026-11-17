import { Module } from '@nestjs/common';
import { EMAIL_QUEUE } from '../../infrastructure/jobs/job-queues';
import { registerJobHandler } from '../../infrastructure/jobs/job-handler.registry';
import { EmailService } from '../services/email.service';
import { EmailQueueService } from '../queues/email/email.queue';
import { EmailJobHandler } from '../queues/email/email-job.handler';

/**
 * Transactional email queue. Jobs run on the selected queue driver
 * (InfrastructureModule); EmailJobHandler processes them in both modes.
 */
@Module({
  providers: [
    EmailQueueService,
    EmailJobHandler,
    EmailService,
    registerJobHandler(EMAIL_QUEUE, EmailJobHandler),
  ],
  exports: [EmailQueueService],
})
export class QueueModule {}
