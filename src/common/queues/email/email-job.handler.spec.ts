import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import config from '../../config/app.config';
import type { JobExecution } from '../../../infrastructure/jobs/job.types';
import type { EmailService } from '../../services/email.service';
import type { PrismaService } from '../../services/prisma.service';
import { sealEmailPayload } from './email-delivery';
import { EmailJobHandler } from './email-job.handler';
import type { EmailJob } from './email.queue';

describe('EmailJobHandler (both queue drivers)', () => {
  const email = mock<EmailService>();
  const prisma = mockDeep<PrismaService>();
  const logger = mock<Logger>();
  const handler = new EmailJobHandler(logger, email, prisma);
  const original = config.jwt_refresh_secret;
  const job = (data: EmailJob): JobExecution<EmailJob> =>
    ({
      id: 'job-1',
      name: 'send',
      data,
      attemptsMade: 0,
      maxAttempts: 3,
    }) as JobExecution<EmailJob>;
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'email-1',
    messageId: 'verification:u1:abc',
    emailType: 'verification',
    emailTo: 'user@example.com',
    retry_count: 0,
    notificationId: null,
    payload: sealEmailPayload('verification:u1:abc', { code: 'A1B2C3' }),
    authUser: { username: 'user' },
    notification: null,
    ...overrides,
  });
  const updates = () =>
    prisma.emailHistory.updateMany.mock.calls.map((call) => call[0]);

  beforeAll(() => {
    config.jwt_refresh_secret = 'email-handler-spec-root-secret';
  });
  afterAll(() => {
    config.jwt_refresh_secret = original;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.emailHistory.updateMany.mockResolvedValue({ count: 1 });
    prisma.emailHistory.findUniqueOrThrow.mockResolvedValue(row() as never);
  });

  it('claims an unsent email, sends it and records it sent with sentAt', async () => {
    await handler.process(job({ type: 'email', emailId: 'email-1' }));

    expect(email.sendVerificationEmail.mock.calls).toEqual([
      ['user@example.com', 'user', 'A1B2C3'],
    ]);
    const [claim, sent] = updates();
    expect(claim?.where).toMatchObject({
      id: 'email-1',
      emailStatus: { in: ['pending', 'failed'] },
    });
    expect(sent?.data).toMatchObject({
      emailStatus: 'sent',
      sentAt: expect.any(Date) as unknown,
      payload: null,
      claimedAt: null,
    });
  });

  it('records a failed attempt and rethrows so the job is retried', async () => {
    const failure = Object.assign(new Error('421 try later'), {
      responseCode: 421,
    });
    email.sendVerificationEmail.mockRejectedValue(failure);

    await expect(
      handler.process(job({ type: 'email', emailId: 'email-1' })),
    ).rejects.toBe(failure);
    expect(updates()[1]?.data).toMatchObject({
      emailStatus: 'failed',
      retry_count: 1,
      errorMessage: 'smtp:421 421 try later',
      claimedAt: null,
      nextAttemptAt: expect.any(Date) as unknown,
    });
  });

  it('retries welcome emails too', async () => {
    prisma.emailHistory.findUniqueOrThrow.mockResolvedValue(
      row({
        emailType: 'welcome',
        messageId: 'welcome:u1',
        payload: null,
      }) as never,
    );
    email.sendWelcomeEmail.mockRejectedValue(new Error('down'));
    await expect(
      handler.process(job({ type: 'email', emailId: 'email-1' })),
    ).rejects.toThrow('down');
  });

  it('sends nothing when the email was already sent or is being sent', async () => {
    prisma.emailHistory.updateMany.mockResolvedValue({ count: 0 });
    await handler.process(job({ type: 'email', emailId: 'email-1' }));
    expect(email.sendVerificationEmail.mock.calls).toEqual([]);
  });

  it('mirrors a notification email on its notification', async () => {
    prisma.emailHistory.findUniqueOrThrow.mockResolvedValue(
      row({
        emailType: 'gift',
        messageId: 'notification:n1',
        payload: null,
        notificationId: 'n1',
        notification: { title: 'T', body: 'B' },
      }) as never,
    );
    await handler.process(job({ type: 'email', emailId: 'email-1' }));
    expect(email.sendNotificationEmail.mock.calls).toEqual([
      ['user@example.com', 'user', 'T', 'B'],
    ]);
    expect(prisma.notification.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'n1' },
      data: { emailStatus: 'SENT', emailAttempts: 1 },
    });
  });
});
