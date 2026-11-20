import { Injectable } from '@nestjs/common';
import { EMAIL_QUEUE } from '../../../infrastructure/jobs/job-queues';
import type { SecurityNotificationEvent } from './security-notifications';
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
 * A security notification (see security-notifications.ts). `historyId` is
 * the emailHistory row recorded with the change; the handler marks it sent
 * or failed.
 */
export interface SecurityNotificationEmailJob {
  type: 'security-notification';
  email: string;
  username: string;
  event: SecurityNotificationEvent;
  occurredAt: string;
  historyId: string;
}

export type EmailJob =
  | VerificationEmailJob
  | WelcomeEmailJob
  | AccountDeletionCodeEmailJob
  | SecurityNotificationEmailJob;

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

  /** Queues a security notification (no secret is ever part of it). */
  async sendSecurityNotification(
    job: Omit<SecurityNotificationEmailJob, 'type'>,
    authId: string,
  ): Promise<void> {
    await this.jobs.dispatch<EmailJob>(EMAIL_QUEUE, {
      name: 'send-security-notification',
      ownerId: authId,
      data: { type: 'security-notification', ...job },
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
