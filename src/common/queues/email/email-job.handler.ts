import { Inject, Injectable } from '@nestjs/common';
import { email_status, NotificationEmailStatus } from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import type {
  AbandonedJob,
  JobExecution,
  JobHandler,
} from '../../../infrastructure/jobs/job.types';
import { EmailService } from '../../services/email.service';
import { PrismaService } from '../../services/prisma.service';
import {
  EMAIL_CLAIM_STALE_MS,
  emailErrorDetail,
  emailRetryDelayMs,
  MAX_EMAIL_ATTEMPTS,
  openEmailPayload,
  UNSENT_EMAIL_STATUSES,
} from './email-delivery';
import type { EmailJob } from './email.queue';

/** Notification email states that follow the email's delivery. */
const MIRRORED: NotificationEmailStatus[] = [
  NotificationEmailStatus.PENDING,
  NotificationEmailStatus.SENDING,
  NotificationEmailStatus.FAILED,
];

/**
 * Sends queued emails. Used by both queue drivers (BullMQ processor and
 * PostgreSQL worker); a thrown error fails the attempt and is retried.
 *
 * An outbox email (emailHistory row) is sent once: the job claims the row
 * (only an unsent, unclaimed row, or one whose claim is stale after a
 * crash), sends it through SMTP and records the outcome on the same row:
 * `sent` with `sentAt` once SMTP accepted it, or `failed` with the error,
 * the failed attempts and the next attempt time. A failed row stays
 * `failed` until a retry (the job's own retries, then EmailOutboxService)
 * delivers it, which makes it `sent`. Every email type is retried,
 * including welcome emails.
 */
@Injectable()
export class EmailJobHandler implements JobHandler<EmailJob> {
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER)
    private readonly logger: Logger,
    private readonly emailService: EmailService,
    private readonly prismaService: PrismaService,
  ) {}

  async process(job: JobExecution<EmailJob>): Promise<void> {
    this.logger.info(`Processing email job: ${job.name} (ID: ${job.id})`, {
      context: 'EmailProcessor',
      jobId: job.id,
      jobName: job.name,
    });
    try {
      const data = job.data;
      switch (data.type) {
        case 'email':
          await this.deliver(data.emailId);
          break;
        case 'notification': {
          // A job queued by an earlier version: its outbox email.
          const email = await this.prismaService.emailHistory.findUnique({
            where: { notificationId: data.notificationId },
            select: { id: true },
          });
          if (email) await this.deliver(email.id);
          break;
        }
        case 'verification':
          await this.emailService.sendVerificationEmail(
            data.email,
            data.username,
            data.verificationCode,
          );
          break;
        case 'welcome':
          await this.emailService.sendWelcomeEmail(data.email, data.username);
          break;
        case 'account-deletion-code':
          await this.emailService.sendAccountDeletionCodeEmail(
            data.email,
            data.username,
            data.code,
            data.expiresInMinutes,
          );
          break;
        default:
          this.logger.warn(
            `Unknown email job type: ${String((data as { type?: string }).type || 'undefined')}`,
            { context: 'EmailProcessor', jobId: job.id },
          );
      }
    } catch (error) {
      this.logger.error(`Failed to process email job ${job.id}`, {
        context: 'EmailProcessor',
        jobId: job.id,
        error: error instanceof Error ? error.name : String(error),
      });
      throw error; // Re-throw to trigger retry
    }
  }

  /**
   * One delivery attempt of an outbox email (if it is still unsent and not
   * being sent by another worker). Throws when SMTP fails, after recording
   * the failure.
   */
  async deliver(emailId: string, now: Date = new Date()): Promise<void> {
    const claimed = await this.prismaService.emailHistory.updateMany({
      where: {
        id: emailId,
        emailStatus: { in: UNSENT_EMAIL_STATUSES },
        retry_count: { lt: MAX_EMAIL_ATTEMPTS },
        OR: [
          { claimedAt: null },
          { claimedAt: { lt: new Date(now.getTime() - EMAIL_CLAIM_STALE_MS) } },
        ],
      },
      data: { claimedAt: now, lastAttemptAt: now },
    });
    // Sent already, given up, or being sent by another worker.
    if (claimed.count === 0) return;
    const email = await this.prismaService.emailHistory.findUniqueOrThrow({
      where: { id: emailId },
      include: {
        authUser: { select: { username: true } },
        notification: { select: { title: true, body: true } },
      },
    });

    try {
      await this.send(email);
    } catch (error) {
      const failures = email.retry_count + 1;
      await this.prismaService.emailHistory.updateMany({
        where: { id: emailId, claimedAt: now },
        data: {
          emailStatus: email_status.failed,
          retry_count: failures,
          errorMessage: emailErrorDetail(error),
          claimedAt: null,
          nextAttemptAt:
            failures >= MAX_EMAIL_ATTEMPTS
              ? null
              : new Date(now.getTime() + emailRetryDelayMs(failures)),
        },
      });
      if (email.notificationId) {
        await this.prismaService.notification.updateMany({
          where: { id: email.notificationId, emailStatus: { in: MIRRORED } },
          data: {
            emailStatus: NotificationEmailStatus.FAILED,
            emailAttempts: failures,
          },
        });
      }
      this.logger.warn('Email delivery failed; it is retried', {
        context: 'EmailProcessor',
        emailId,
        emailType: email.emailType,
        failures,
      });
      throw error;
    }

    const sentAt = new Date();
    await this.prismaService.emailHistory.updateMany({
      where: { id: emailId, claimedAt: now },
      data: {
        emailStatus: email_status.sent,
        sentAt,
        payload: null,
        claimedAt: null,
        nextAttemptAt: null,
      },
    });
    if (email.notificationId) {
      await this.prismaService.notification.updateMany({
        where: { id: email.notificationId, emailStatus: { in: MIRRORED } },
        data: {
          emailStatus: NotificationEmailStatus.SENT,
          emailSentAt: sentAt,
          emailAttempts: email.retry_count + 1,
        },
      });
    }
    this.logger.info('Email sent', {
      context: 'EmailProcessor',
      emailId,
      emailType: email.emailType,
    });
  }

  /** SMTP delivery of one outbox email, by its type. */
  private async send(email: {
    messageId: string;
    emailType: string;
    emailTo: string;
    payload: string | null;
    authUser: { username: string };
    notification: { title: string; body: string } | null;
  }): Promise<void> {
    const username = email.authUser.username;
    switch (email.emailType) {
      case 'verification': {
        const secret = openEmailPayload(email.messageId, email.payload);
        await this.emailService.sendVerificationEmail(
          email.emailTo,
          username,
          String(secret.code),
        );
        return;
      }
      case 'welcome':
        await this.emailService.sendWelcomeEmail(email.emailTo, username);
        return;
      case 'account_deletion': {
        const secret = openEmailPayload(email.messageId, email.payload);
        await this.emailService.sendAccountDeletionCodeEmail(
          email.emailTo,
          username,
          String(secret.code),
          Number(secret.minutes),
        );
        return;
      }
      default: {
        if (!email.notification) {
          throw new Error(`Email ${email.messageId} has no content`);
        }
        await this.emailService.sendNotificationEmail(
          email.emailTo,
          username,
          email.notification.title,
          email.notification.body,
        );
      }
    }
  }

  /**
   * A job whose attempts were used up while sending was interrupted
   * (PostgreSQL driver): its email's claim is released so the outbox
   * dispatches it again (the failure itself was recorded by the attempt).
   */
  async onAbandoned(job: AbandonedJob<EmailJob>): Promise<void> {
    if (job.data?.type !== 'email') return;
    await this.prismaService.emailHistory.updateMany({
      where: {
        id: job.data.emailId,
        emailStatus: { in: UNSENT_EMAIL_STATUSES },
      },
      data: { claimedAt: null, nextAttemptAt: new Date() },
    });
  }
}
