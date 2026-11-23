import { Injectable } from '@nestjs/common';
import { email_type } from '@prisma/client';
import { EMAIL_QUEUE } from '../../../infrastructure/jobs/job-queues';
import {
  JobDispatcher,
  type JobRequest,
} from '../../../infrastructure/jobs/job.types';
import { CustomLoggerService } from '../../services/custom-logger.service';
import { PrismaService } from '../../services/prisma.service';
import {
  EMAIL_SUBJECTS,
  type EmailRecordInput,
  recordEmail,
  secretDigest,
} from './email-delivery';

/**
 * One email of the outbox (emailHistory). Only the id travels with the job:
 * the handler reads the row (and decrypts its secrets) when it runs.
 */
export interface OutboxEmailJob {
  type: 'email';
  emailId: string;
}

// Jobs queued by earlier versions (still processed after an upgrade).
export interface VerificationEmailJob {
  type: 'verification';
  email: string;
  username: string;
  verificationCode: string;
  authId: string;
}

export interface WelcomeEmailJob {
  type: 'welcome';
  email: string;
  username: string;
  authId?: string;
}

export interface AccountDeletionCodeEmailJob {
  type: 'account-deletion-code';
  email: string;
  username: string;
  code: string;
  expiresInMinutes: number;
}

export interface NotificationEmailJob {
  type: 'notification';
  notificationId: string;
}

export type EmailJob =
  | OutboxEmailJob
  | VerificationEmailJob
  | WelcomeEmailJob
  | AccountDeletionCodeEmailJob
  | NotificationEmailJob;

/** 3 attempts, exponential backoff from 2 seconds. */
const RETRIES = {
  attempts: 3,
  backoff: { type: 'exponential', delayMs: 2000 },
} as const satisfies Partial<JobRequest<EmailJob>>;

/**
 * Queues emails. Every email is first recorded in the email outbox
 * (emailHistory, its delivery history) with a unique message id derived
 * from its event, then an email job is dispatched on the selected queue
 * driver (BullMQ or PostgreSQL). If the job cannot be queued, the recorded
 * email is still sent: EmailOutboxService dispatches every due email.
 */
@Injectable()
export class EmailQueueService {
  constructor(
    private readonly jobs: JobDispatcher,
    private readonly prisma: PrismaService,
    private readonly logger: CustomLoggerService,
  ) {}

  /** The verification code of an account (one email per code). */
  async sendVerificationEmail(
    email: string,
    _username: string,
    verificationCode: string,
    authId: string,
    meta: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<void> {
    await this.queue({
      authId,
      emailTo: email,
      type: email_type.verification,
      subject: EMAIL_SUBJECTS.verification,
      messageId: `verification:${authId}:${secretDigest(verificationCode)}`,
      secret: { code: verificationCode },
      ...meta,
    });
  }

  /** The welcome email after verification (once per account). */
  async sendWelcomeEmail(
    email: string,
    _username: string,
    authId: string,
  ): Promise<void> {
    await this.queue({
      authId,
      emailTo: email,
      type: email_type.welcome,
      subject: EMAIL_SUBJECTS.welcome,
      messageId: `welcome:${authId}`,
    });
  }

  /**
   * The one-time code that confirms an account deletion (one email per
   * code). The code is stored encrypted with the email until it is sent.
   */
  async sendAccountDeletionCode(
    email: string,
    _username: string,
    code: string,
    expiresInMinutes: number,
    authId: string,
  ): Promise<void> {
    await this.queue({
      authId,
      emailTo: email,
      type: email_type.account_deletion,
      subject: EMAIL_SUBJECTS.accountDeletion,
      messageId: `account-deletion:${authId}:${secretDigest(code)}`,
      secret: { code, minutes: expiresInMinutes },
    });
  }

  /**
   * Dispatches the job of a recorded email. The job id is derived from the
   * email and its dispatch round, so dispatching it again adds nothing;
   * the handler also claims the email before sending, so it is sent once.
   */
  async sendEmail(
    emailId: string,
    authId: string | null,
    dispatchKey: string,
  ): Promise<void> {
    await this.jobs.dispatch<EmailJob>(EMAIL_QUEUE, {
      name: 'send-email',
      jobId: `email-${emailId}-${dispatchKey}`,
      ownerId: authId ?? undefined,
      data: { type: 'email', emailId },
      ...RETRIES,
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }

  /** Records the email (idempotent), then dispatches its job. */
  private async queue(input: EmailRecordInput): Promise<void> {
    const email = await recordEmail(this.prisma, input);
    if (email.status !== 'pending' && email.status !== 'failed') return;
    try {
      await this.sendEmail(email.id, input.authId, email.dispatchKey);
    } catch (error) {
      // Recorded: the email outbox dispatches it later.
      this.logger.logWithMetadata(
        'warn',
        'Email recorded but not queued; the email outbox retries it',
        {
          context: 'EmailQueueService',
          emailId: email.id,
          error: error instanceof Error ? error.name : 'unknown',
        },
      );
    }
  }
}
