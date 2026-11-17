import { mock } from 'jest-mock-extended';
import { JobDispatcher } from '../../../infrastructure/jobs/job.types';
import { EmailQueueService } from './email.queue';

describe('EmailQueueService', () => {
  const jobs = mock<JobDispatcher>();
  const service = new EmailQueueService(jobs);
  const retries = {
    attempts: 3,
    backoff: { type: 'exponential', delayMs: 2000 },
  };

  beforeEach(() => jest.resetAllMocks());

  it('queues a verification email owned by the account', async () => {
    await service.sendVerificationEmail('a@example.com', 'a', 'C0DE42', 'u1');

    expect(jobs.dispatch.mock.calls).toEqual([
      [
        'email',
        {
          name: 'send-verification',
          ownerId: 'u1',
          data: {
            type: 'verification',
            email: 'a@example.com',
            username: 'a',
            verificationCode: 'C0DE42',
            authId: 'u1',
          },
          ...retries,
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      ],
    ]);
  });

  it('queues a welcome email owned by the account', async () => {
    await service.sendWelcomeEmail('a@example.com', 'a', 'u1');

    expect(jobs.dispatch.mock.calls[0]?.[1]).toMatchObject({
      name: 'send-welcome',
      ownerId: 'u1',
      ...retries,
    });
  });

  it('queues an account deletion code owned by the account and removed once done', async () => {
    await service.sendAccountDeletionCode(
      'a@example.com',
      'a',
      'Z9Y8X7',
      10,
      'u1',
    );

    expect(jobs.dispatch.mock.calls[0]?.[1]).toMatchObject({
      name: 'send-account-deletion-code',
      ownerId: 'u1',
      ...retries,
      removeOnComplete: true,
      removeOnFail: true,
    });
  });
});
