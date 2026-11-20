import { Inject, Injectable } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import type {
  AbandonedJob,
  JobExecution,
  JobHandler,
} from '../../../infrastructure/jobs/job.types';
import { EmailService } from '../../services/email.service';
import { PrismaService } from '../../services/prisma.service';
import type { EmailJob } from './email.queue';

/**
 * Sends queued emails. Used by both queue drivers (BullMQ processor and
 * PostgreSQL worker); a thrown error fails the attempt and is retried.
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
      switch (job.data.type) {
        case 'verification':
          await this.handleVerificationEmail(job);
          break;
        case 'welcome':
          await this.handleWelcomeEmail(job);
          break;
        case 'account-deletion-code': {
          const data = job.data;
          await this.emailService.sendAccountDeletionCodeEmail(
            data.email,
            data.username,
            data.code,
            data.expiresInMinutes,
          );
          // The code itself is never logged.
          this.logger.info('Account deletion code email sent', {
            context: 'EmailProcessor',
            jobId: job.id,
          });
          break;
        }
        case 'security-notification':
          await this.handleSecurityNotification(job);
          break;
        default:
          this.logger.warn(
            `Unknown email job type: ${String((job.data as { type?: string }).type || 'undefined')}`,
            { context: 'EmailProcessor', jobId: job.id },
          );
      }
    } catch (error) {
      this.logger.error(`Failed to process email job ${job.id}`, {
        context: 'EmailProcessor',
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error; // Re-throw to trigger retry
    }
  }

  /**
   * A verification email whose sending was interrupted on its last attempt
   * (PostgreSQL driver) is recorded as failed, like a failed send.
   */
  async onAbandoned(job: AbandonedJob<EmailJob>): Promise<void> {
    if (job.data?.type === 'security-notification') {
      await this.prismaService.emailHistory.updateMany({
        where: { id: job.data.historyId, emailStatus: 'pending' },
        data: {
          emailStatus: 'failed',
          errorMessage: 'Sending was interrupted',
        },
      });
      return;
    }
    if (job.data?.type !== 'verification') return;
    await this.markVerificationFailed(
      job.data.authId,
      'Sending was interrupted',
    );
  }

  private async handleVerificationEmail(
    job: JobExecution<EmailJob>,
  ): Promise<void> {
    const data = job.data as Extract<EmailJob, { type: 'verification' }>;
    const { email, username, verificationCode, authId } = data;

    try {
      // Send the email
      await this.emailService.sendVerificationEmail(
        email,
        username,
        verificationCode,
      );

      // Update email history status to 'sent'
      await this.prismaService.emailHistory.updateMany({
        where: {
          authId,
          emailType: 'verification',
          emailStatus: 'pending',
        },
        data: {
          emailStatus: 'sent',
        },
      });

      this.logger.info(`Verification email sent successfully to ${email}`, {
        context: 'EmailProcessor',
        jobId: job.id,
        email,
      });
    } catch (error) {
      this.logger.error(`Failed to send verification email to ${email}`, {
        context: 'EmailProcessor',
        email,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Update email history status to 'failed'
      await this.markVerificationFailed(
        authId,
        error instanceof Error ? error.message : 'Failed to send email',
      );

      throw error; // Re-throw to trigger retry
    }
  }

  private async markVerificationFailed(
    authId: string,
    errorMessage: string,
  ): Promise<void> {
    await this.prismaService.emailHistory.updateMany({
      where: {
        authId,
        emailType: 'verification',
        emailStatus: 'pending',
      },
      data: {
        emailStatus: 'failed',
        errorMessage,
      },
    });
  }

  /**
   * Sends a security notification and records the outcome on the
   * emailHistory row written together with the change. Only the event and
   * the job are logged (the email itself holds no secret either).
   */
  private async handleSecurityNotification(
    job: JobExecution<EmailJob>,
  ): Promise<void> {
    const data = job.data as Extract<
      EmailJob,
      { type: 'security-notification' }
    >;
    try {
      await this.emailService.sendSecurityNotificationEmail(
        data.email,
        data.username,
        data.event,
        data.occurredAt,
      );
      await this.prismaService.emailHistory.updateMany({
        where: { id: data.historyId },
        data: { emailStatus: 'sent', errorMessage: null },
      });
      this.logger.info('Security notification sent', {
        context: 'EmailProcessor',
        jobId: job.id,
        event: data.event,
      });
    } catch (error) {
      await this.prismaService.emailHistory.updateMany({
        where: { id: data.historyId },
        data: {
          emailStatus: 'failed',
          errorMessage: error instanceof Error ? error.name : 'Error',
          retry_count: { increment: 1 },
        },
      });
      throw error; // retried by the queue
    }
  }

  private async handleWelcomeEmail(job: JobExecution<EmailJob>): Promise<void> {
    const data = job.data as Extract<EmailJob, { type: 'welcome' }>;
    const { email, username } = data;

    try {
      await this.emailService.sendWelcomeEmail(email, username);
      this.logger.info(`Welcome email sent successfully to ${email}`, {
        context: 'EmailProcessor',
        jobId: job.id,
        email,
      });
    } catch (error) {
      this.logger.error(`Failed to send welcome email to ${email}`, {
        context: 'EmailProcessor',
        email,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw for welcome emails - they're non-critical
      // Just log the error and mark job as complete
    }
  }
}
