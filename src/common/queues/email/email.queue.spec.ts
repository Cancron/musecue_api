import { mock, mockDeep } from 'jest-mock-extended';
import config from '../../config/app.config';
import { JobDispatcher } from '../../../infrastructure/jobs/job.types';
import type { CustomLoggerService } from '../../services/custom-logger.service';
import type { PrismaService } from '../../services/prisma.service';
import { openEmailPayload } from './email-delivery';
import { EmailQueueService } from './email.queue';

describe('EmailQueueService (email outbox)', () => {
  const jobs = mock<JobDispatcher>();
  const prisma = mockDeep<PrismaService>();
  const logger = mock<CustomLoggerService>();
  const service = new EmailQueueService(jobs, prisma, logger);
  const original = config.jwt_refresh_secret;
  const recorded = () => prisma.emailHistory.createMany.mock.calls[0]?.[0];

  beforeAll(() => {
    config.jwt_refresh_secret = 'email-queue-spec-root-secret';
  });
  afterAll(() => {
    config.jwt_refresh_secret = original;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.emailHistory.findUniqueOrThrow.mockResolvedValue({
      id: 'email-1',
      retry_count: 0,
      emailStatus: 'pending',
      nextAttemptAt: new Date(1000),
    } as never);
  });

  it('records a verification email with its code encrypted, then queues its job', async () => {
    await service.sendVerificationEmail('a@example.com', 'a', 'C0DE42', 'u1');

    const data = (recorded()?.data as Array<Record<string, unknown>>)[0];
    expect(data).toMatchObject({
      authId: 'u1',
      emailTo: 'a@example.com',
      emailType: 'verification',
      emailStatus: 'pending',
    });
    expect(String(data.messageId)).toMatch(/^verification:u1:[0-9a-f]{24}$/);
    expect(String(data.payload)).not.toContain('C0DE42');
    expect(
      openEmailPayload(String(data.messageId), String(data.payload)),
    ).toEqual({ code: 'C0DE42' });
    expect(recorded()?.skipDuplicates).toBe(true);
    expect(jobs.dispatch.mock.calls).toEqual([
      [
        'email',
        {
          name: 'send-email',
          jobId: 'email-email-1-0-1000',
          ownerId: 'u1',
          data: { type: 'email', emailId: 'email-1' },
          attempts: 3,
          backoff: { type: 'exponential', delayMs: 2000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      ],
    ]);
  });

  it('records one welcome email per account', async () => {
    await service.sendWelcomeEmail('a@example.com', 'a', 'u1');
    expect(
      (recorded()?.data as Array<Record<string, unknown>>)[0],
    ).toMatchObject({ messageId: 'welcome:u1', emailType: 'welcome' });
  });

  it('records an account deletion code encrypted', async () => {
    await service.sendAccountDeletionCode(
      'a@example.com',
      'a',
      'Z9Y8X7',
      10,
      'u1',
    );
    const data = (recorded()?.data as Array<Record<string, unknown>>)[0];
    expect(data.emailType).toBe('account_deletion');
    expect(String(data.payload)).not.toContain('Z9Y8X7');
  });

  it('queues nothing for an email already sent', async () => {
    prisma.emailHistory.findUniqueOrThrow.mockResolvedValue({
      id: 'email-1',
      retry_count: 0,
      emailStatus: 'sent',
      nextAttemptAt: null,
    } as never);
    await service.sendWelcomeEmail('a@example.com', 'a', 'u1');
    expect(jobs.dispatch.mock.calls).toEqual([]);
  });

  it('keeps a recorded email when its job cannot be queued (the outbox retries it)', async () => {
    jobs.dispatch.mockRejectedValue(new Error('queue down'));
    await expect(
      service.sendWelcomeEmail('a@example.com', 'a', 'u1'),
    ).resolves.toBeUndefined();
    expect(logger.logWithMetadata.mock.calls[0]?.[1]).toMatch(/outbox/);
  });

  it('fails when the email cannot be recorded', async () => {
    prisma.emailHistory.createMany.mockRejectedValue(new Error('db down'));
    await expect(
      service.sendWelcomeEmail('a@example.com', 'a', 'u1'),
    ).rejects.toThrow('db down');
  });
});
