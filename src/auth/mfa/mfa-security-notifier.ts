import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import { EmailQueueService } from '../../common/queues/email/email.queue';
import {
  SECURITY_NOTIFICATIONS,
  type SecurityNotificationEvent,
} from '../../common/queues/email/security-notifications';
import type { ActivityLogMetadata } from '../../common/services/activity-log.service';
import { PrismaService } from '../../common/services/prisma.service';

/** A notification recorded with a change, to be sent once it committed. */
export interface PendingSecurityNotification {
  authId: string;
  historyId: string;
  email: string;
  username: string;
  event: SecurityNotificationEvent;
  occurredAt: string;
}

const CONTEXT = 'MfaSecurityNotifier';

/**
 * Security notifications of MFA changes, in two steps:
 *
 * 1. `record` runs inside the change's transaction: it writes the
 *    notification's emailHistory row (pending), so the database log of the
 *    change and of its notification commit or roll back with the change.
 * 2. `dispatch` runs after the commit and queues the email. It never fails
 *    the change: if the queue is unavailable the row is marked failed (and
 *    the change is still recorded in the activity log).
 *
 * Neither the email nor any record holds a secret, code or token.
 */
@Injectable()
export class MfaSecurityNotifier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailQueue: EmailQueueService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async record(
    tx: Prisma.TransactionClient,
    input: {
      authId: string;
      event: SecurityNotificationEvent;
      metadata: ActivityLogMetadata;
      now: Date;
    },
  ): Promise<PendingSecurityNotification> {
    const user = await tx.authUser.findUniqueOrThrow({
      where: { id: input.authId },
      select: { email: true, username: true },
    });
    const history = await tx.emailHistory.create({
      data: {
        authId: input.authId,
        emailTo: user.email,
        emailType: 'notification',
        subject: SECURITY_NOTIFICATIONS[input.event].subject,
        messageId: `security-${input.event.toLowerCase()}-${randomUUID()}`,
        emailStatus: 'pending',
        ipAddress: input.metadata.ip,
        userAgent: input.metadata.userAgent,
        sentAt: input.now,
        createdAt: input.now,
      },
      select: { id: true },
    });
    return {
      authId: input.authId,
      historyId: history.id,
      email: user.email,
      username: user.username,
      event: input.event,
      occurredAt: input.now.toISOString(),
    };
  }

  async dispatch(notification: PendingSecurityNotification): Promise<void> {
    const { authId, ...job } = notification;
    try {
      await this.emailQueue.sendSecurityNotification(job, authId);
    } catch (error) {
      this.logger.warn('Security notification could not be queued', {
        context: CONTEXT,
        authId,
        event: notification.event,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      await this.prisma.emailHistory
        .updateMany({
          where: { id: notification.historyId, emailStatus: 'pending' },
          data: { emailStatus: 'failed', errorMessage: 'Could not be queued' },
        })
        .catch(() => undefined);
    }
  }
}
