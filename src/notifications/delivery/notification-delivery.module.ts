import { Module } from '@nestjs/common';
import { QueueModule } from '../../common/modules';
import { EmailOutboxService } from './email-outbox.service';

/**
 * Email delivery (QueueModule's email queue and the email outbox sweep that
 * dispatches every due email). Loaded by AppModule only.
 */
@Module({
  imports: [QueueModule],
  providers: [EmailOutboxService],
  exports: [EmailOutboxService],
})
export class NotificationDeliveryModule {}
