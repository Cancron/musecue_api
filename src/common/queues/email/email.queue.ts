import { Injectable } from '@nestjs/common';
import { EMAIL_QUEUE } from '../../../infrastructure/jobs/job-queues';
import {
  JobDispatcher,
  type JobRequest,
} from '../../../infrastructure/jobs/job.types';

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

/**
 * The email of one inbox notification. Only the id travels with the job;
 * the handler reads the notification and the recipient when it runs.
 */
export interface NotificationEmailJob {
  type: 'notification';
  notificationId: string;
}

export type EmailJob =
  | VerificationEmailJob
  | WelcomeEmailJob
  | AccountDeletionCodeEmailJob
  | NotificationEmailJob;

/** 3 attempts, exponential backoff from 2 seconds. */
const RETRIES = {
  attempts: 3,
  backoff: { type: 'exponential', delayMs: 2000 },
} as const satisfies Partial<JobRequest<EmailJob>>;

/** Queues transactional emails on the selected queue driver. */
@Injectable()
export class EmailQueueService {
  constructor(private readonly jobs: JobDispatcher) {}

  async sendVerificationEmail(
    email: string,
    username: string,
    verificationCode: string,
    authId: string,
  ): Promise<void> {
    await this.jobs.dispatch<EmailJob>(EMAIL_QUEUE, {
      name: 'send-verification',
      ownerId: authId,
      data: {
        type: 'verification',
        email,
        username,
        verificationCode,
        authId,
      },
      ...RETRIES,
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }

  /**
   * Queues the one-time code that confirms an account deletion. The job holds
   * a secret, so it is removed from the queue as soon as it finishes or fails.
   */
  async sendAccountDeletionCode(
    email: string,
    username: string,
    code: string,
    expiresInMinutes: number,
    authId?: string,
  ): Promise<void> {
    await this.jobs.dispatch<EmailJob>(EMAIL_QUEUE, {
      name: 'send-account-deletion-code',
      ownerId: authId,
      data: {
        type: 'account-deletion-code',
        email,
        username,
        code,
        expiresInMinutes,
      },
      ...RETRIES,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /**
   * Queues the email of a notification. The job id is derived from the
   * notification and its attempt count, so dispatching it again adds nothing;
   * the handler also claims the notification before sending, so it is
   * emailed once.
   */
  async sendNotificationEmail(
    notificationId: string,
    authId: string,
    attempt = 0,
  ): Promise<void> {
    await this.jobs.dispatch<EmailJob>(EMAIL_QUEUE, {
      name: 'send-notification',
      // One job per claim round: a notification returned to PENDING after
      // an interrupted or failed attempt gets a new job, while dispatching
      // the same round again is deduplicated.
      jobId: `notification-email-${notificationId}-${attempt}`,
      ownerId: authId,
      data: { type: 'notification', notificationId },
      ...RETRIES,
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }

  async sendWelcomeEmail(
    email: string,
    username: string,
    authId?: string,
  ): Promise<void> {
    await this.jobs.dispatch<EmailJob>(EMAIL_QUEUE, {
      name: 'send-welcome',
      ownerId: authId,
      data: { type: 'welcome', email, username, authId },
      ...RETRIES,
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }
}
