import { Module } from '@nestjs/common';
import { QueueModule } from '../../common/modules';
import { NotificationOutboxService } from './notification-outbox.service';

/**
 * Email delivery of notifications through the existing email queue
 * (QueueModule): the outbox dispatcher. Loaded by AppModule only.
 */
@Module({
  imports: [QueueModule],
  providers: [NotificationOutboxService],
  exports: [NotificationOutboxService],
})
export class NotificationDeliveryModule {}
