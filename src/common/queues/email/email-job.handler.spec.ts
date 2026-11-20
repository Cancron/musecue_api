import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import type { JobExecution } from '../../../infrastructure/jobs/job.types';
import type { EmailService } from '../../services/email.service';
import type { PrismaService } from '../../services/prisma.service';
import { EmailJobHandler } from './email-job.handler';
import type { EmailJob } from './email.queue';

describe('EmailJobHandler (both queue drivers)', () => {
  const email = mock<EmailService>();
  const prisma = mockDeep<PrismaService>();
  const logger = mock<Logger>();
  const handler = new EmailJobHandler(logger, email, prisma);
  const job = (data: EmailJob): JobExecution<EmailJob> =>
    ({
      id: 'job-1',
      name: 'send',
      data,
      attemptsMade: 0,
      maxAttempts: 3,
    }) as JobExecution<EmailJob>;
  const verification: EmailJob = {
    type: 'verification',
    email: 'user@example.com',
    username: 'user',
    verificationCode: 'A1B2C3',
    authId: 'user-1',
  };

  beforeEach(() => jest.resetAllMocks());

  it('sends a verification email and records it as sent', async () => {
    await handler.process(job(verification));

    expect(email.sendVerificationEmail.mock.calls).toContainEqual([
      'user@example.com',
      'user',
      'A1B2C3',
    ]);
    expect(prisma.emailHistory.updateMany.mock.calls).toContainEqual([
      {
        where: {
          authId: 'user-1',
          emailType: 'verification',
          emailStatus: 'pending',
        },
        data: { emailStatus: 'sent' },
      },
    ]);
  });

  it('records a failed verification email and rethrows so the attempt is retried', async () => {
    const failure = new Error('SMTP unavailable');
    email.sendVerificationEmail.mockRejectedValue(failure);

    await expect(handler.process(job(verification))).rejects.toBe(failure);
    expect(prisma.emailHistory.updateMany.mock.calls[0]?.[0].data).toEqual({
      emailStatus: 'failed',
      errorMessage: 'SMTP unavailable',
    });
  });

  it('never fails a job for a welcome email', async () => {
    email.sendWelcomeEmail.mockRejectedValue(new Error('SMTP unavailable'));
    await expect(
      handler.process(
        job({ type: 'welcome', email: 'user@example.com', username: 'user' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('sends an account deletion code without logging it', async () => {
    await handler.process(
      job({
        type: 'account-deletion-code',
        email: 'user@example.com',
        username: 'user',
        code: 'Z9Y8X7',
        expiresInMinutes: 10,
      }),
    );
    expect(email.sendAccountDeletionCodeEmail.mock.calls).toContainEqual([
      'user@example.com',
      'user',
      'Z9Y8X7',
      10,
    ]);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('Z9Y8X7');
  });

  it('records an interrupted verification email as failed', async () => {
    await handler.onAbandoned({
      id: 'job-1',
      name: 'send-verification',
      data: verification,
      reason: 'INTERRUPTED',
    });
    expect(prisma.emailHistory.updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        authId: 'user-1',
        emailType: 'verification',
        emailStatus: 'pending',
      },
      data: { emailStatus: 'failed', errorMessage: 'Sending was interrupted' },
    });

    await handler.onAbandoned({
      id: 'job-2',
      name: 'send-welcome',
      data: undefined,
      reason: 'UNREADABLE',
    });
    expect(prisma.emailHistory.updateMany.mock.calls).toHaveLength(1);
  });

  describe('security notifications', () => {
    const notification: EmailJob = {
      type: 'security-notification',
      email: 'user@example.com',
      username: 'user',
      event: 'MFA_DISABLED',
      occurredAt: '2026-11-26T09:00:00.000Z',
      historyId: 'history-1',
    };

    it('sends it and marks exactly its emailHistory row as sent', async () => {
      await handler.process(job(notification));

      expect(email.sendSecurityNotificationEmail.mock.calls).toEqual([
        [
          'user@example.com',
          'user',
          'MFA_DISABLED',
          '2026-11-26T09:00:00.000Z',
        ],
      ]);
      expect(prisma.emailHistory.updateMany.mock.calls).toEqual([
        [
          {
            where: { id: 'history-1' },
            data: { emailStatus: 'sent', errorMessage: null },
          },
        ],
      ]);
    });

    it('marks it failed (error class only) and rethrows for a retry', async () => {
      const failure = new Error('SMTP said: user@example.com rejected');
      email.sendSecurityNotificationEmail.mockRejectedValue(failure);

      await expect(handler.process(job(notification))).rejects.toBe(failure);
      expect(prisma.emailHistory.updateMany.mock.calls[0]?.[0]).toEqual({
        where: { id: 'history-1' },
        data: {
          emailStatus: 'failed',
          errorMessage: 'Error',
          retry_count: { increment: 1 },
        },
      });
    });

    it('marks an interrupted last attempt as failed', async () => {
      await handler.onAbandoned({
        id: 'job-1',
        name: 'send',
        data: notification,
      } as never);
      expect(prisma.emailHistory.updateMany.mock.calls[0]?.[0]).toEqual({
        where: { id: 'history-1', emailStatus: 'pending' },
        data: {
          emailStatus: 'failed',
          errorMessage: 'Sending was interrupted',
        },
      });
    });
  });
});
