import { Prisma } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../common/services/prisma.service';
import { CreditEligibilityService } from '../../subscription/credit-eligibility.service';
import { CreditAccountService } from './credit-account.service';

const D = (value: string | number) => new Prisma.Decimal(value);
const AT = new Date('2026-12-01T12:00:00.000Z');

describe('CreditAccountService', () => {
  const prisma = mockDeep<PrismaService>();
  const eligibility = mock<CreditEligibilityService>();
  const service = new CreditAccountService(prisma, eligibility);

  const row = (overrides: Record<string, unknown>) => ({
    id: 'tx-1',
    sequence: BigInt(7),
    walletId: 'w',
    authId: 'user-1',
    type: 'DEBIT',
    amount: D('-1.5'),
    overageAmount: D(2),
    balanceAfter: D(0),
    idempotencyKey: 'debit:ai-run:run-1',
    sessionId: 'session-1',
    description: 'AI GUIDE_QUESTION (m)',
    usageCostUsd: D('0.0175'),
    creditCostUsdMicros: 5000,
    occurredAt: AT,
    createdAt: AT,
    entries: [
      {
        allocationId: 'trial',
        amount: D(-1),
        allocation: { source: 'TRIAL', expiresAt: AT },
      },
      {
        allocationId: 'purchase',
        amount: D('-0.5'),
        allocation: { source: 'PURCHASE', expiresAt: null },
      },
    ],
    aiUsage: {
      id: 'usage-1',
      runId: 'run-1',
      operation: 'GUIDE_QUESTION',
      model: 'm',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: D('0.0175'),
      creditCostUsdMicros: 5000,
      creditsDue: D('3.5'),
      creditsCharged: D('3.5'),
    },
    ...overrides,
  });

  beforeEach(() => jest.resetAllMocks());

  it("lists only the caller's transactions, newest first, with sources, overage, session and AI usage", async () => {
    prisma.creditTransaction.findMany.mockResolvedValue([
      row({}),
      row({ id: 'tx-0', sequence: BigInt(6) }),
    ] as never);
    prisma.makeupSession.findMany.mockResolvedValue([
      { id: 'session-1', status: 'IN_PROGRESS', createdAt: AT },
    ] as never);

    const page = await service.listTransactions('user-1', { limit: 1 });

    expect(prisma.creditTransaction.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { authId: 'user-1' },
      orderBy: { sequence: 'desc' },
      take: 2,
    });
    expect(prisma.makeupSession.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: { in: ['session-1'] }, authId: 'user-1' },
    });
    expect(page.nextCursor).toBe('7');
    expect(page.items).toEqual([
      expect.objectContaining({
        type: 'DEDUCTION',
        amount: '-1.5',
        overageAmount: '2',
        creditsCharged: '3.5',
        source: 'MIXED',
        sources: [
          {
            source: 'TRIAL',
            amount: '-1',
            allocationId: 'trial',
            expiresAt: AT.toISOString(),
          },
          {
            source: 'PURCHASE',
            amount: '-0.5',
            allocationId: 'purchase',
            expiresAt: null,
          },
          {
            source: 'SESSION_OVERAGE',
            amount: '-2',
            allocationId: null,
            expiresAt: null,
          },
        ],
        sessionId: 'session-1',
        session: {
          id: 'session-1',
          status: 'IN_PROGRESS',
          createdAt: AT.toISOString(),
        },
        aiUsage: expect.objectContaining({
          inputTokens: 100,
          outputTokens: 20,
          creditCostUsdMicros: 5000,
          creditCostUsd: '0.005',
          creditsCharged: '3.5',
        }) as unknown,
      }),
    ]);
  });

  it.each([
    ['ALLOCATION', { type: 'GRANT' }],
    ['DEDUCTION', { type: 'DEBIT' }],
    ['EXPIRATION', { type: 'EXPIRATION' }],
    ['OVERAGE', { type: 'DEBIT', overageAmount: { gt: 0 } }],
  ] as const)('filters %s transactions', async (type, where) => {
    prisma.creditTransaction.findMany.mockResolvedValue([]);
    await service.listTransactions('user-1', { type, before: '42' });
    expect(prisma.creditTransaction.findMany.mock.calls[0]?.[0]?.where).toEqual(
      { authId: 'user-1', sequence: { lt: BigInt(42) }, ...where },
    );
  });

  it("refuses a session filter naming another user's (or a missing) session", async () => {
    prisma.makeupSession.findFirst.mockResolvedValue(null);
    prisma.creditTransaction.findFirst.mockResolvedValue(null);
    await expect(
      service.listTransactions('user-1', { sessionId: 'not-mine' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.makeupSession.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: 'not-mine',
      authId: 'user-1',
    });
    expect(prisma.creditTransaction.findMany.mock.calls).toHaveLength(0);
  });

  it("keeps the history of the caller's deleted session readable", async () => {
    prisma.makeupSession.findFirst.mockResolvedValue(null);
    prisma.creditTransaction.findFirst.mockResolvedValue({ id: 'tx' } as never);
    prisma.creditTransaction.findMany.mockResolvedValue([row({})] as never);
    prisma.makeupSession.findMany.mockResolvedValue([]);

    const page = await service.listTransactions('user-1', {
      sessionId: 'session-1',
    });
    expect(page.items[0]).toMatchObject({
      sessionId: 'session-1',
      session: null,
    });
  });
});
