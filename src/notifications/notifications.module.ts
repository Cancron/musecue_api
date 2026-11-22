import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

/**
 * Notifications: creation (inside the transaction of the event that causes
 * them) and the owner's inbox and email preferences. Email delivery is in
 * NotificationDeliveryModule (loaded by AppModule).
 */
@Module({
  controllers: [NotificationController],
  providers: [NotificationService, AuthGuard],
  exports: [NotificationService],
})
export class NotificationsModule {}
