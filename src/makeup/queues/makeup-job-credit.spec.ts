import type { AiUsage, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { mock, mockDeep } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { PrismaService } from '../../common/services/prisma.service';
import type { JobExecution } from '../../infrastructure/jobs/job.types';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import type { AiGateway } from '../ai/ai.gateway';
import { AiProviderError } from '../ai/ai-provider.error';
import { MockAiGateway } from '../ai/mock-ai.gateway';
import { MakeupCreditService } from '../makeup-credit.service';
import { MakeupJobHandler } from './makeup-job.handler';
import type { MakeupAiJob } from './makeup.queue';

/** A GUIDE_GENERATION run that is PROCESSING and can be published. */
function runningGuide() {
  const prisma = mockDeep<PrismaService>();
  prisma.$queryRaw.mockResolvedValue([{ status: 'GUIDE_GENERATING' }]);
  prisma.aiRun.findUnique.mockResolvedValue({
    id: 'run',
    authId: 'owner',
    sessionId: 'session',
    operation: 'GUIDE_GENERATION',
    status: 'PROCESSING',
    startedAt: new Date(1000),
    createdAt: new Date(0),
  } as never);
  prisma.aiRun.updateMany.mockResolvedValue({ count: 1 });
  prisma.$transaction.mockImplementation(((
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => callback(prisma)) as PrismaService['$transaction']);
  prisma.makeupSession.findFirstOrThrow.mockResolvedValue({
    preferences: {
      vibe: 'natural',
      skillLevel: null,
      occasion: null,
      desiredEffect: null,
      timeMinutes: 10,
      notes: null,
    },
    faceAnalysis: null,
    recommendations: [
      {
        id: 'look',
        rank: 1,
        name: 'Natural',
        tagline: 'Soft',
        matchScore: 90,
        imageUrl: '',
        palette: ['rose'],
        rationale: 'r',
        selectedAt: new Date(),
      },
    ],
  } as never);
  return prisma;
}

const job = (discard = jest.fn()) =>
  ({
    name: 'GUIDE_GENERATION',
    data: { runId: 'run', authId: 'owner', sessionId: 'session' },
    maxAttempts: 3,
    attemptsMade: 0,
    discard,
  }) as unknown as JobExecution<MakeupAiJob>;

describe('MakeupJobHandler AI usage and credits', () => {
  const usage = { id: 'usage-1' } as AiUsage;
  const metadata = {
    responseId: 'gen-1',
    model: 'openai/gpt-4.1-mini',
    usage: { totalTokens: 900, costUsd: '0.023' },
  };
  let prisma: ReturnType<typeof runningGuide>;
  let ai: ReturnType<typeof mock<AiGateway>>;
  let credits: ReturnType<typeof mock<MakeupCreditService>>;
  let handler: MakeupJobHandler;

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    prisma = runningGuide();
    ai = mock<AiGateway>();
    credits = mock<MakeupCreditService>();
    ai.describe.mockReturnValue({
      provider: 'openrouter',
      model: 'openai/gpt-4.1-mini',
      promptVersion: 'v',
    });
    const guide = await new MockAiGateway().generateGuide({
      preferences: {
        vibe: 'natural',
        skillLevel: null,
        occasion: null,
        desiredEffect: null,
        timeMinutes: 10,
        notes: null,
      },
      recommendation: {
        rank: 1,
        name: 'Natural',
        tagline: 'Soft',
        matchScore: 90,
        imageUrl: '',
        palette: ['rose'],
        rationale: 'r',
      },
      analysis: null,
    });
    ai.generateGuide.mockResolvedValue({ data: guide.data, metadata });
    handler = new MakeupJobHandler(
      prisma,
      ai,
      mock<PrivateImageStorageService>(),
      mock<Logger>(),
      new ConfigService(),
      credits,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('makes no provider request for a user who cannot pay, and fails the run with "Insufficient credits"', async () => {
    credits.assertCanUseAi.mockRejectedValue(
      new AiProviderError(
        'INSUFFICIENT_CREDITS',
        'Insufficient credits',
        false,
      ),
    );
    const discard = jest.fn();

    await expect(handler.process(job(discard))).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
    });

    expect(credits.assertCanUseAi.mock.calls).toEqual([['owner', 'session']]);
    expect(ai.generateGuide.mock.calls).toHaveLength(0);
    expect(discard).toHaveBeenCalled();
    expect(prisma.aiRun.updateMany.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: 'FAILED',
      error: 'Insufficient credits',
    });
  });

  it('records the usage of the provider response and charges the run in the transaction that publishes its result', async () => {
    credits.recordUsage.mockResolvedValue(usage);
    const order: string[] = [];
    prisma.guide.create.mockImplementation((() => {
      order.push('publish');
      return Promise.resolve({});
    }) as never);
    credits.chargeRun.mockImplementation((() => {
      order.push('charge');
      return Promise.resolve({});
    }) as never);

    credits.usableSources.mockResolvedValue(['PURCHASE']);

    await handler.process(job());

    expect(credits.recordUsage.mock.calls).toEqual([
      [
        { runId: 'run', authId: 'owner', sessionId: 'session' },
        'GUIDE_GENERATION',
        'openrouter',
        metadata,
      ],
    ]);
    // Only the credits the user may use now, read before the transaction.
    expect(credits.usableSources.mock.calls).toEqual([['owner']]);
    expect(credits.chargeRun.mock.calls).toEqual([
      [prisma, usage, ['PURCHASE']],
    ]);
    expect(order).toEqual(['publish', 'charge']);
    expect(credits.discard.mock.calls).toHaveLength(0);
  });

  it('does not charge a result that can no longer be published', async () => {
    credits.recordUsage.mockResolvedValue(usage);
    // Claimed as PROCESSING, then failed by recovery before publishing.
    prisma.aiRun.findUnique
      .mockResolvedValueOnce({ status: 'PROCESSING', jobInput: null } as never)
      .mockResolvedValue({
        status: 'FAILED',
        startedAt: new Date(1000),
      } as never);

    await handler.process(job());

    expect(prisma.guide.create.mock.calls).toHaveLength(0);
    expect(credits.chargeRun.mock.calls).toHaveLength(0);
    expect(credits.discard.mock.calls).toEqual([[usage]]);
  });

  it('records a response the provider billed before the request failed, never charging it', async () => {
    const error = new AiProviderError(
      'AI_SCHEMA_VALIDATION_FAILED',
      'AI output failed application validation',
      true,
    );
    error.billedResponse = metadata;
    ai.generateGuide.mockRejectedValue(error);

    await expect(handler.process(job())).rejects.toBe(error);

    expect(credits.recordUsage.mock.calls).toEqual([
      [
        { runId: 'run', authId: 'owner', sessionId: 'session' },
        'GUIDE_GENERATION',
        'openrouter',
        metadata,
        error,
      ],
    ]);
    expect(credits.chargeRun.mock.calls).toHaveLength(0);
  });

  it('settles the usage of an attempt whose result could not be published as not charged', async () => {
    credits.recordUsage.mockResolvedValue(usage);
    prisma.guide.create.mockRejectedValue(new Error('db down'));

    await expect(handler.process(job())).rejects.toThrow('db down');

    expect(credits.discard.mock.calls).toEqual([[usage, 'FAILED_ATTEMPT']]);
  });
});
