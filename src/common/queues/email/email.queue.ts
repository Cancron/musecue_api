import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

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

export type EmailJob =
  | VerificationEmailJob
  | WelcomeEmailJob
  | AccountDeletionCodeEmailJob;

@Injectable()
export class EmailQueueService {
  constructor(@InjectQueue('email') private emailQueue: Queue) {}

  async sendVerificationEmail(
    email: string,
    username: string,
    verificationCode: string,
    authId: string,
  ): Promise<void> {
    await this.emailQueue.add(
      'send-verification',
      {
        type: 'verification',
        email,
        username,
        verificationCode,
        authId,
      } as VerificationEmailJob,
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
  }

  /**
   * Queues the one-time code that confirms an account deletion. The job holds
   * a secret, so it is removed from Redis as soon as it finishes or fails.
   */
  async sendAccountDeletionCode(
    email: string,
    username: string,
    code: string,
    expiresInMinutes: number,
  ): Promise<void> {
    await this.emailQueue.add(
      'send-account-deletion-code',
      {
        type: 'account-deletion-code',
        email,
        username,
        code,
        expiresInMinutes,
      } as AccountDeletionCodeEmailJob,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async sendWelcomeEmail(
    email: string,
    username: string,
    authId?: string,
  ): Promise<void> {
    await this.emailQueue.add(
      'send-welcome',
      {
        type: 'welcome',
        email,
        username,
        authId,
      } as WelcomeEmailJob,
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
  }
}
