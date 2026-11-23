import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  EMAIL_CLAIM_STALE_MS,
  emailDispatchKey,
  MAX_EMAIL_ATTEMPTS,
  UNSENT_EMAIL_STATUSES,
} from '../../common/queues/email/email-delivery';
import { EmailQueueService } from '../../common/queues/email/email.queue';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';

const LOG_CONTEXT = 'EmailOutboxService';
const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;
const BATCH = 200;

/**
 * The email outbox sweep. Every email is recorded in emailHistory before it
 * is queued (notification emails in the transaction of their event); this
 * service dispatches the email job of every unsent email that is due
 * (`nextAttemptAt`): new emails whose job could not be queued or whose
 * notification was created in another transaction, failed emails whose
 * next attempt has come (after the job's own quick retries were used up),
 * and emails whose sending was interrupted (claim older than 10 minutes).
 * It runs at startup (so nothing recorded before a restart or a crash is
 * lost) and every EMAIL_OUTBOX_INTERVAL_MS (default 5000, minimum 1000).
 * Dispatching twice is harmless: the job id derives from the email and its
 * failed attempts, and the job claims the email before sending. Emails are
 * given up after MAX_EMAIL_ATTEMPTS failed attempts (they stay `failed`).
 *
 * Started unless NODE_ENV=test (EMAIL_OUTBOX_ENABLED=true starts it there
 * too); dispatchPending() can be called directly.
 */
@Injectable()
export class EmailOutboxService
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
      (process.env.EMAIL_OUTBOX_ENABLED ??
        process.env.NOTIFICATION_OUTBOX_ENABLED) === 'true';
    if (!enabled) return;
    await this.tick();
    const configured = Number(
      process.env.EMAIL_OUTBOX_INTERVAL_MS ??
        process.env.NOTIFICATION_OUTBOX_INTERVAL_MS,
    );
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

  /** Dispatches every due email; returns how many. */
  dispatchPending(now: Date = new Date()): Promise<number> {
    // One pass at a time per instance.
    this.running ??= this.dispatch(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async tick(): Promise<void> {
    try {
      await this.dispatchPending();
    } catch (error) {
      this.logger.logWithMetadata('warn', 'Email outbox pass failed', {
        context: LOG_CONTEXT,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private async dispatch(now: Date): Promise<number> {
    // Interrupted sends (the worker stopped): due again, in a new round.
    await this.prisma.emailHistory.updateMany({
      where: {
        emailStatus: { in: UNSENT_EMAIL_STATUSES },
        claimedAt: { lt: new Date(now.getTime() - EMAIL_CLAIM_STALE_MS) },
      },
      data: { claimedAt: null, nextAttemptAt: now },
    });
    const due = await this.prisma.emailHistory.findMany({
      where: {
        emailStatus: { in: UNSENT_EMAIL_STATUSES },
        retry_count: { lt: MAX_EMAIL_ATTEMPTS },
        nextAttemptAt: { lte: now },
        claimedAt: null,
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: BATCH,
      select: {
        id: true,
        authId: true,
        retry_count: true,
        nextAttemptAt: true,
      },
    });
    for (const email of due) {
      await this.emails.sendEmail(
        email.id,
        email.authId,
        emailDispatchKey(email),
      );
    }
    return due.length;
  }
}
