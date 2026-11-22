import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { NotificationEmailStatus } from '@prisma/client';
import { EmailQueueService } from '../../common/queues/email/email.queue';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';

const LOG_CONTEXT = 'NotificationOutboxService';
const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;
const BATCH = 200;
/** A SENDING claim older than this was interrupted (worker stopped). */
const STALE_CLAIM_MS = 10 * 60_000;

/**
 * Hands notification emails to the existing email queue. Notifications are
 * written with their event (an outbox); this service dispatches every
 * PENDING one as an email job whose id is derived from the notification
 * and its attempt count, at startup (so emails of notifications created
 * before a restart or a crash are still sent) and then every
 * NOTIFICATION_OUTBOX_INTERVAL_MS
 * (default 5000, minimum 1000). Dispatching twice is harmless: the job id
 * deduplicates the job and the handler claims the notification before
 * sending. Interrupted claims are returned to PENDING.
 *
 * Started unless NODE_ENV=test (NOTIFICATION_OUTBOX_ENABLED=true starts it
 * there too); dispatchPending() can be called directly.
 */
@Injectable()
export class NotificationOutboxService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emails: EmailQueueService,
    private readonly logger: CustomLoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const enabled =
      process.env.NODE_ENV !== 'test' ||
      process.env.NOTIFICATION_OUTBOX_ENABLED === 'true';
    if (!enabled) return;
    await this.tick();
    const configured = Number(process.env.NOTIFICATION_OUTBOX_INTERVAL_MS);
    const interval =
      Number.isFinite(configured) && configured >= MIN_INTERVAL_MS
        ? configured
        : DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Dispatches every PENDING notification email; returns how many. */
  dispatchPending(): Promise<number> {
    // One pass at a time per instance.
    this.running ??= this.dispatch().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async tick(): Promise<void> {
    try {
      await this.dispatchPending();
    } catch (error) {
      this.logger.logWithMetadata('warn', 'Notification outbox pass failed', {
        context: LOG_CONTEXT,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private async dispatch(): Promise<number> {
    await this.prisma.notification.updateMany({
      where: {
        emailStatus: NotificationEmailStatus.SENDING,
        emailClaimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) },
      },
      data: { emailStatus: NotificationEmailStatus.PENDING },
    });
    const pending = await this.prisma.notification.findMany({
      where: { emailStatus: NotificationEmailStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: { id: true, authId: true, emailAttempts: true },
    });
    for (const notification of pending) {
      await this.emails.sendNotificationEmail(
        notification.id,
        notification.authId,
        notification.emailAttempts,
      );
    }
    return pending.length;
  }
}
