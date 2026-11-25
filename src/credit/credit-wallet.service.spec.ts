import {
  CreditSource,
  CreditTransactionType,
  Prisma,
  type CreditAllocation,
  type CreditSessionOverage,
  type CreditTransaction,
  type CreditWallet,
} from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import { CreditSettingsService } from './credit-settings.service';
import {
  CreditWalletService,
  TRIAL_ENDED_BY_PRO_REFERENCE,
} from './credit-wallet.service';
import { InsufficientCreditsError } from './credit.errors';

const INSUFFICIENT = { status: 403, message: 'Insufficient credits' };
const d = (value: string | number) => new Prisma.Decimal(value);
const NOW = new Date('2026-11-24T12:00:00.000Z');
const LATER = new Date('2026-12-24T12:00:00.000Z');
const AUTH_ID = 'user-1';
const WALLET_ID = 'wallet-1';

/**
 * Orchestration of CreditWalletService with a mocked Prisma client. The
 * locking, constraints and concurrency behaviour are verified against real
 * PostgreSQL in test/credit-wallet.e2e-spec.ts.
 */
describe('CreditWalletService', () => {
  const prisma = mockDeep<PrismaService>();
  const settings = mock<CreditSettingsService>();
  const service = new CreditWalletService(prisma, settings);

  const wallet = (overrides: Partial<CreditWallet> = {}): CreditWallet => ({
    id: WALLET_ID,
    authId: AUTH_ID,
    balanceCredits: d(0),
    outstandingOverageCredits: d(0),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

  const allocationRow = (
    overrides: Partial<CreditAllocation> = {},
  ): CreditAllocation => ({
    id: 'alloc-1',
    walletId: WALLET_ID,
    source: CreditSource.PURCHASE,
    sourceReference: 'payment-1',
    grantedCredits: d(10),
    remainingCredits: d(10),
    expiresAt: null,
    expiredAt: null,
    grantedAt: NOW,
    updatedAt: NOW,
    subscriptionId: null,
    paymentId: null,
    periodStartsAt: null,
    ...overrides,
  });

  /** Transactions written in this test, as passed to create(). */
  const written = () =>
    prisma.creditTransaction.create.mock.calls.map(
      ([args]) => args.data as Record<string, unknown>,
    );
  const amounts = (row: Record<string, unknown>, field: string) =>
    (row[field] as Prisma.Decimal).toFixed();

  const givenWallet = (state: Partial<CreditWallet> = {}, lastSequence = 0) => {
    prisma.creditWallet.findUniqueOrThrow.mockResolvedValue(wallet(state));
    prisma.creditTransaction.findFirst.mockResolvedValue(
      lastSequence
        ? ({ sequence: lastSequence } as unknown as CreditTransaction)
        : null,
    );
  };

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.authUser.findUnique.mockResolvedValue({ id: AUTH_ID } as never);
    prisma.creditWallet.createMany.mockResolvedValue({ count: 0 });
    prisma.$queryRaw.mockResolvedValue([{ id: WALLET_ID }]);
    givenWallet();
    prisma.creditAllocation.findMany.mockResolvedValue([]);
    prisma.creditAllocation.create.mockImplementation(((args: {
      data: Partial<CreditAllocation>;
    }) => Promise.resolve(allocationRow({ ...args.data }))) as never);
    prisma.creditTransaction.create.mockImplementation(((args: {
      data: Partial<CreditTransaction>;
    }) =>
      Promise.resolve({
        id: `tx-${prisma.creditTransaction.create.mock.calls.length}`,
        createdAt: NOW,
        ...args.data,
      })) as never);
    prisma.creditSessionOverage.findMany.mockResolvedValue([]);
    settings.getSettings.mockResolvedValue({
      trialAllowanceCredits: 50,
      proMonthlyAllowanceCredits: 1000,
      openRouterUsdMicrosPerCredit: 5000,
      openRouterUsdPerCredit: '0.005',
      sessionOverageAllowanceCredits: 5,
      updatedAt: NOW.toISOString(),
    });
  });

  describe('allocate', () => {
    const purchase = {
      authId: AUTH_ID,
      source: CreditSource.PURCHASE,
      sourceReference: 'payment-1',
      credits: '10.5',
      now: NOW,
    };

    it('locks the wallet, stores the allocation for the right user and source, and appends a chained ALLOCATION transaction', async () => {
      givenWallet({ balanceCredits: d('2.25') }, 3);

      const result = await service.allocate(purchase);

      expect(prisma.creditWallet.createMany.mock.calls).toEqual([
        [{ data: [{ authId: AUTH_ID }], skipDuplicates: true }],
      ]);
      expect(
        Array.from(
          prisma.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray,
        ).join('?'),
      ).toMatch(/FOR UPDATE/);
      expect(prisma.creditAllocation.create.mock.calls[0]?.[0].data).toEqual({
        walletId: WALLET_ID,
        source: CreditSource.PURCHASE,
        sourceReference: 'payment-1',
        grantedCredits: d('10.5'),
        remainingCredits: d('10.5'),
        expiresAt: null,
        grantedAt: NOW,
        // Only SUBSCRIPTION credits are linked to a paid period.
        subscriptionId: null,
        paymentId: null,
        periodStartsAt: null,
      });
      const [tx] = written();
      expect(tx).toMatchObject({
        walletId: WALLET_ID,
        sequence: 4,
        type: CreditTransactionType.ALLOCATION,
        idempotencyKey: 'allocation:alloc-1',
        allocationId: 'alloc-1',
      });
      expect(amounts(tx, 'amountCredits')).toBe('10.5');
      expect(amounts(tx, 'balanceAfterCredits')).toBe('12.75');
      expect(
        prisma.creditTransactionEntry.createMany.mock.calls[0]?.[0],
      ).toEqual({
        data: [
          {
            transactionId: 'tx-1',
            walletId: WALLET_ID,
            allocationId: 'alloc-1',
            amountCredits: d('10.5'),
          },
        ],
      });
      expect(prisma.creditWallet.update.mock.calls[0]?.[0].data).toMatchObject({
        balanceCredits: d('12.75'),
        outstandingOverageCredits: d(0),
      });
      expect(result).toMatchObject({
        created: true,
        allocation: { grantedCredits: '10.5', remainingCredits: '10.5' },
      });
    });

    it('returns the existing allocation when the same allocation is repeated', async () => {
      prisma.creditAllocation.findUnique.mockResolvedValue(
        allocationRow({ grantedCredits: d('10.5'), remainingCredits: d(3) }),
      );

      const result = await service.allocate(purchase);

      expect(result).toMatchObject({
        created: false,
        allocation: { id: 'alloc-1', remainingCredits: '3' },
      });
      expect(prisma.creditAllocation.create.mock.calls).toHaveLength(0);
      expect(prisma.creditTransaction.create.mock.calls).toHaveLength(0);
    });

    it.each([
      ['another user', { walletId: 'other-wallet' }],
      ['a different amount', { grantedCredits: d('10') }],
    ])(
      'refuses to reuse a source event for %s (409)',
      async (_case, existing) => {
        prisma.creditAllocation.findUnique.mockResolvedValue(
          allocationRow({ grantedCredits: d('10.5'), ...existing }),
        );

        await expect(service.allocate(purchase)).rejects.toMatchObject({
          status: 409,
        });
        expect(prisma.creditAllocation.create.mock.calls).toHaveLength(0);
      },
    );

    it('refuses a second trial allocation for the same user (409)', async () => {
      prisma.creditAllocation.findFirst.mockResolvedValue(
        allocationRow({ source: CreditSource.TRIAL }),
      );

      await expect(
        service.allocate({
          authId: AUTH_ID,
          source: CreditSource.TRIAL,
          sourceReference: 'trial:2',
          credits: 50,
          expiresAt: LATER,
          now: NOW,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(prisma.creditAllocation.create.mock.calls).toHaveLength(0);
    });

    it.each([
      ['a trial without expiry', CreditSource.TRIAL, null, '1'],
      ['a subscription expiring now', CreditSource.SUBSCRIPTION, NOW, '1'],
      ['a purchase with an expiry', CreditSource.PURCHASE, LATER, '1'],
      ['a referral with an expiry', CreditSource.REFERRAL, LATER, '1'],
      ['a zero amount', CreditSource.PURCHASE, null, '0'],
      ['a negative amount', CreditSource.PURCHASE, null, '-5'],
      ['7 decimal places', CreditSource.PURCHASE, null, '0.0000001'],
    ])(
      'rejects %s (400) before opening a transaction',
      async (_case, source, expiresAt, credits) => {
        await expect(
          service.allocate({
            authId: AUTH_ID,
            source,
            sourceReference: 'ref',
            credits,
            expiresAt,
            now: NOW,
          }),
        ).rejects.toMatchObject({ status: 400 });
        expect(prisma.$transaction.mock.calls).toHaveLength(0);
      },
    );

    it('rejects an unknown user (404)', async () => {
      prisma.authUser.findUnique.mockResolvedValue(null);

      await expect(service.allocate(purchase)).rejects.toMatchObject({
        status: 404,
      });
      expect(prisma.creditWallet.createMany.mock.calls).toHaveLength(0);
    });

    it('repays outstanding session overage from the new credits first', async () => {
      givenWallet({ outstandingOverageCredits: d('3.5') }, 5);
      prisma.creditSessionOverage.findMany.mockResolvedValue([
        {
          id: 'overage-1',
          walletId: WALLET_ID,
          sessionId: 'session-1',
          limitCredits: d(5),
          overageCredits: d('3.5'),
          settledCredits: d(0),
          createdAt: NOW,
          updatedAt: NOW,
        } satisfies CreditSessionOverage,
      ]);
      prisma.creditAllocation.update.mockImplementation(((args: {
        data: Partial<CreditAllocation>;
      }) =>
        Promise.resolve(
          allocationRow({ grantedCredits: d('10.5'), ...args.data }),
        )) as never);

      const result = await service.allocate(purchase);

      const [allocationTx, settlementTx] = written();
      expect(amounts(allocationTx, 'balanceAfterCredits')).toBe('10.5');
      expect(settlementTx).toMatchObject({
        sequence: 7,
        type: CreditTransactionType.OVERAGE_SETTLEMENT,
        idempotencyKey: 'overage-settlement:alloc-1',
      });
      expect(amounts(settlementTx, 'amountCredits')).toBe('-3.5');
      expect(amounts(settlementTx, 'overageChangeCredits')).toBe('-3.5');
      expect(amounts(settlementTx, 'balanceAfterCredits')).toBe('7');
      expect(amounts(settlementTx, 'outstandingOverageAfterCredits')).toBe('0');
      expect(
        prisma.creditSessionOverage.update.mock.calls[0]?.[0].data,
      ).toEqual({ settledCredits: d('3.5') });
      expect(result.allocation.remainingCredits).toBe('7');
    });
  });

  describe('deduct', () => {
    const deduction = {
      authId: AUTH_ID,
      credits: '1.25',
      idempotencyKey: 'ai-run-1',
      now: NOW,
    };

    it('spends soonest-expiring credits first and records one entry per allocation', async () => {
      givenWallet({ balanceCredits: d('10.75') }, 2);
      prisma.creditAllocation.findMany
        .mockResolvedValueOnce([]) // nothing due for expiry
        .mockResolvedValueOnce([
          allocationRow({ id: 'purchase', remainingCredits: d(10) }),
          allocationRow({
            id: 'trial',
            source: CreditSource.TRIAL,
            remainingCredits: d('0.75'),
            expiresAt: LATER,
          }),
        ]);

      const result = await service.deduct(deduction);

      const [tx] = written();
      expect(tx).toMatchObject({
        sequence: 3,
        type: CreditTransactionType.DEDUCTION,
        idempotencyKey: 'deduction:ai-run-1',
        sessionId: null,
      });
      expect(amounts(tx, 'amountCredits')).toBe('-1.25');
      expect(amounts(tx, 'balanceAfterCredits')).toBe('9.5');
      expect(
        prisma.creditTransactionEntry.createMany.mock.calls[0]?.[0]?.data,
      ).toEqual([
        expect.objectContaining({
          allocationId: 'trial',
          amountCredits: d('-0.75'),
        }),
        expect.objectContaining({
          allocationId: 'purchase',
          amountCredits: d('-0.5'),
        }),
      ]);
      expect(
        prisma.creditAllocation.update.mock.calls.map(([args]) => args),
      ).toEqual([
        { where: { id: 'trial' }, data: { remainingCredits: d(0) } },
        { where: { id: 'purchase' }, data: { remainingCredits: d('9.5') } },
      ]);
      expect(result.duplicate).toBe(false);
    });

    it('expires due allocations before spending, recording the expiry time', async () => {
      givenWallet({ balanceCredits: d(12) }, 1);
      const expiresAt = new Date(NOW.getTime() - 1000);
      prisma.creditAllocation.findMany
        .mockResolvedValueOnce([
          allocationRow({
            id: 'old-trial',
            source: CreditSource.TRIAL,
            remainingCredits: d(2),
            expiresAt,
          }),
        ])
        .mockResolvedValueOnce([
          allocationRow({ id: 'purchase', remainingCredits: d(10) }),
        ]);

      await service.deduct(deduction);

      const [expiration, deductionTx] = written();
      expect(expiration).toMatchObject({
        sequence: 2,
        type: CreditTransactionType.EXPIRATION,
        idempotencyKey: 'expiration:old-trial',
        allocationId: 'old-trial',
        effectiveAt: expiresAt,
      });
      expect(amounts(expiration, 'amountCredits')).toBe('-2');
      expect(amounts(expiration, 'balanceAfterCredits')).toBe('10');
      expect(prisma.creditAllocation.update.mock.calls[0]?.[0]).toEqual({
        where: { id: 'old-trial' },
        data: { remainingCredits: d(0), expiredAt: NOW },
      });
      expect(amounts(deductionTx, 'balanceAfterCredits')).toBe('8.75');
    });

    it('refuses a deduction that does not fit (403 Insufficient credits) and writes nothing', async () => {
      givenWallet({ balanceCredits: d(1) }, 1);
      prisma.creditAllocation.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([allocationRow({ remainingCredits: d(1) })]);

      const refusal = service.deduct(deduction);
      await expect(refusal).rejects.toBeInstanceOf(InsufficientCreditsError);
      await expect(refusal).rejects.toMatchObject({
        status: 403,
        message: 'Insufficient credits',
      });
      expect(prisma.creditTransaction.create.mock.calls).toHaveLength(0);
      expect(prisma.creditAllocation.update.mock.calls).toHaveLength(0);
      expect(prisma.creditWallet.update.mock.calls).toHaveLength(0);
    });

    it('charges a session shortfall as overage, limited by the per-session allowance from the settings', async () => {
      givenWallet({ balanceCredits: d(1) }, 1);
      prisma.makeupSession.findFirst.mockResolvedValue({
        id: 'session-1',
      } as never);
      prisma.creditAllocation.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([allocationRow({ remainingCredits: d(1) })]);
      prisma.creditSessionOverage.findUnique.mockResolvedValue(null);

      await service.deduct({
        ...deduction,
        credits: '4',
        sessionId: 'session-1',
      });

      expect(prisma.makeupSession.findFirst.mock.calls[0]?.[0]).toEqual({
        where: { id: 'session-1', authId: AUTH_ID },
        select: { id: true },
      });
      const [tx] = written();
      expect(amounts(tx, 'amountCredits')).toBe('-1');
      expect(amounts(tx, 'overageChangeCredits')).toBe('3');
      expect(amounts(tx, 'outstandingOverageAfterCredits')).toBe('3');
      expect(
        prisma.creditSessionOverage.create.mock.calls[0]?.[0].data,
      ).toEqual({
        walletId: WALLET_ID,
        sessionId: 'session-1',
        limitCredits: d(5),
        overageCredits: d(3),
      });
    });

    it('keeps the session limit fixed once the session has used overage', async () => {
      prisma.makeupSession.findFirst.mockResolvedValue({
        id: 'session-1',
      } as never);
      prisma.creditSessionOverage.findUnique.mockResolvedValue({
        id: 'overage-1',
        walletId: WALLET_ID,
        sessionId: 'session-1',
        limitCredits: d(2),
        overageCredits: d('1.5'),
        settledCredits: d(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      givenWallet({ outstandingOverageCredits: d('1.5') }, 4);

      // The settings now allow 5, but this session keeps its limit of 2.
      await expect(
        service.deduct({ ...deduction, credits: '1', sessionId: 'session-1' }),
      ).rejects.toMatchObject(INSUFFICIENT);
      expect(settings.getSettings.mock.calls).toHaveLength(0);
    });

    it('refuses a session that does not belong to the user (404)', async () => {
      prisma.makeupSession.findFirst.mockResolvedValue(null);

      await expect(
        service.deduct({ ...deduction, sessionId: 'someone-elses' }),
      ).rejects.toMatchObject({ status: 404 });
      expect(prisma.creditTransaction.create.mock.calls).toHaveLength(0);
    });

    it('returns the original transaction when the idempotency key is repeated', async () => {
      prisma.creditTransaction.findUnique.mockResolvedValue({
        id: 'tx-9',
        walletId: WALLET_ID,
        sequence: 9,
        type: CreditTransactionType.DEDUCTION,
        amountCredits: d('-1'),
        overageChangeCredits: d('0.25'),
        balanceAfterCredits: d(0),
        outstandingOverageAfterCredits: d('0.25'),
        idempotencyKey: 'deduction:ai-run-1',
        allocationId: null,
        sessionId: null,
        reference: null,
        effectiveAt: NOW,
        createdAt: NOW,
        entries: [],
      } as never);

      const result = await service.deduct(deduction);

      expect(result).toMatchObject({
        duplicate: true,
        transaction: { id: 'tx-9', sequence: 9 },
      });
      expect(prisma.creditTransaction.create.mock.calls).toHaveLength(0);
    });

    it('refuses to reuse an idempotency key for a different amount (409)', async () => {
      prisma.creditTransaction.findUnique.mockResolvedValue({
        amountCredits: d('-2'),
        overageChangeCredits: d(0),
        sessionId: null,
      } as never);

      await expect(service.deduct(deduction)).rejects.toMatchObject({
        status: 409,
      });
    });

    it.each([
      ['an empty key', { idempotencyKey: '  ' }],
      ['an overlong key', { idempotencyKey: 'k'.repeat(151) }],
      ['a negative amount', { credits: '-1' }],
      ['an amount needing rounding', { credits: 0.1234567 }],
      ['an overlong session id', { sessionId: 's'.repeat(65) }],
    ])(
      'rejects %s (400) before opening a transaction',
      async (_case, change) => {
        await expect(
          service.deduct({ ...deduction, ...change }),
        ).rejects.toMatchObject({ status: 400 });
        expect(prisma.$transaction.mock.calls).toHaveLength(0);
      },
    );
  });

  describe('monthly Pro credits (SUBSCRIPTION, linked to a paid period)', () => {
    const PERIOD_START = new Date('2026-11-20T08:00:00.000Z');
    const PERIOD_END = new Date('2026-12-20T08:00:00.000Z');
    const payment = (
      overrides: Partial<{
        billingInterval: 'MONTHLY' | 'YEARLY';
        periodEnd: Date;
      }> = {},
    ) => ({
      id: 'pay-1',
      billingInterval: 'MONTHLY' as 'MONTHLY' | 'YEARLY',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      ...overrides,
    });
    const givenAllowance = (proMonthlyAllowanceCredits: number) =>
      settings.getSettings.mockResolvedValue({
        trialAllowanceCredits: 50,
        proMonthlyAllowanceCredits,
        openRouterUsdMicrosPerCredit: 5000,
        openRouterUsdPerCredit: '0.005',
        sessionOverageAllowanceCredits: 5,
        updatedAt: NOW.toISOString(),
      });
    const linkedRow = (subscriptionId: string) =>
      allocationRow({
        source: CreditSource.SUBSCRIPTION,
        sourceReference: 'pro:pay-1',
        grantedCredits: d(1000),
        expiresAt: PERIOD_END,
        subscriptionId,
        paymentId: 'pay-1',
        periodStartsAt: PERIOD_START,
      });
    const sameAllocation = {
      authId: AUTH_ID,
      subscriptionId: 'sub-1',
      paymentId: 'pay-1',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      credits: 1000,
      now: NOW,
    };

    it('refuses SUBSCRIPTION credits through the generic allocate (400): they only come from a paid period', async () => {
      await expect(
        service.allocate({
          authId: AUTH_ID,
          source: CreditSource.SUBSCRIPTION,
          sourceReference: 'pro:manual',
          credits: 1000,
          expiresAt: LATER,
          now: NOW,
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });

    it("allocates the admin-configured allowance for the payment's period, linked to user, subscription and payment", async () => {
      givenAllowance(1500);

      const result = await service.allocateProMonthlyCreditsInTransaction(
        prisma,
        {
          authId: AUTH_ID,
          subscriptionId: 'sub-1',
          payment: payment(),
          now: NOW,
        },
      );

      expect(settings.getSettings.mock.calls).toEqual([[prisma]]);
      expect(prisma.creditAllocation.create.mock.calls[0]?.[0].data).toEqual({
        walletId: WALLET_ID,
        source: CreditSource.SUBSCRIPTION,
        sourceReference: 'pro:pay-1',
        grantedCredits: d(1500),
        remainingCredits: d(1500),
        expiresAt: PERIOD_END,
        grantedAt: NOW,
        subscriptionId: 'sub-1',
        paymentId: 'pay-1',
        periodStartsAt: PERIOD_START,
      });
      const [allocationTx] = written();
      expect(allocationTx).toMatchObject({
        type: CreditTransactionType.ALLOCATION,
        allocationId: 'alloc-1',
      });
      expect(amounts(allocationTx, 'amountCredits')).toBe('1500');
      expect(result?.created).toBe(true);
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });

    it.each([
      [
        'a yearly payment (not supported yet)',
        payment({ billingInterval: 'YEARLY' }),
        1000,
      ],
      ['a period that has already ended', payment({ periodEnd: NOW }), 1000],
      ['an allowance of 0', payment(), 0],
    ])('allocates nothing for %s', async (_case, paid, allowance) => {
      givenAllowance(allowance);

      await expect(
        service.allocateProMonthlyCreditsInTransaction(prisma, {
          authId: AUTH_ID,
          subscriptionId: 'sub-1',
          payment: paid,
          now: NOW,
        }),
      ).resolves.toBeNull();
      expect(prisma.creditAllocation.create.mock.calls).toHaveLength(0);
      expect(prisma.creditTransaction.create.mock.calls).toHaveLength(0);
    });

    it('returns the existing allocation when the same payment is allocated again', async () => {
      prisma.creditAllocation.findUnique.mockResolvedValue(linkedRow('sub-1'));

      const again = await service.allocateSubscriptionCredits(sameAllocation);

      expect(again).toMatchObject({
        created: false,
        allocation: {
          paymentId: 'pay-1',
          subscriptionId: 'sub-1',
          periodStartsAt: PERIOD_START.toISOString(),
        },
      });
      expect(prisma.creditAllocation.create.mock.calls).toHaveLength(0);
    });

    it("refuses to reuse a payment's allocation for another subscription (409)", async () => {
      prisma.creditAllocation.findUnique.mockResolvedValue(
        linkedRow('other-sub'),
      );

      await expect(
        service.allocateSubscriptionCredits(sameAllocation),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("trial credits (inside the caller's transaction)", () => {
    const tx = prisma;

    it('allocateInTransaction writes through the given transaction without opening its own', async () => {
      const result = await service.allocateInTransaction(tx, {
        authId: AUTH_ID,
        source: CreditSource.TRIAL,
        sourceReference: 'trial:sub-1',
        credits: 50,
        expiresAt: LATER,
        now: NOW,
      });

      expect(prisma.$transaction.mock.calls).toHaveLength(0);
      expect(
        prisma.creditAllocation.create.mock.calls[0]?.[0].data,
      ).toMatchObject({
        source: CreditSource.TRIAL,
        sourceReference: 'trial:sub-1',
        grantedCredits: d(50),
        expiresAt: LATER,
        grantedAt: NOW,
      });
      expect(result.created).toBe(true);
    });

    it('expireTrialCredits ends unused trial credits early, dated now, and leaves other sources alone', async () => {
      givenWallet({ balanceCredits: d(62) }, 3);
      const trial = allocationRow({
        id: 'trial',
        source: CreditSource.TRIAL,
        remainingCredits: d(42),
        expiresAt: LATER,
      });
      prisma.creditAllocation.findMany
        .mockResolvedValueOnce([]) // nothing due for regular expiry
        .mockResolvedValueOnce([trial]);

      await expect(service.expireTrialCredits(tx, AUTH_ID, NOW)).resolves.toBe(
        1,
      );

      // Only TRIAL allocations with credits left are selected.
      expect(
        prisma.creditAllocation.findMany.mock.calls[1]?.[0]?.where,
      ).toEqual({
        walletId: WALLET_ID,
        source: CreditSource.TRIAL,
        remainingCredits: { gt: 0 },
      });
      const [expiration] = written();
      expect(expiration).toMatchObject({
        sequence: 4,
        type: CreditTransactionType.EXPIRATION,
        idempotencyKey: 'expiration:trial',
        allocationId: 'trial',
        reference: TRIAL_ENDED_BY_PRO_REFERENCE,
        effectiveAt: NOW,
      });
      expect(amounts(expiration, 'amountCredits')).toBe('-42');
      expect(amounts(expiration, 'balanceAfterCredits')).toBe('20');
      expect(prisma.creditAllocation.update.mock.calls[0]?.[0]).toEqual({
        where: { id: 'trial' },
        data: { remainingCredits: d(0), expiredAt: NOW },
      });
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });

    it('expireTrialCredits does nothing for a user without a wallet', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.expireTrialCredits(tx, AUTH_ID, NOW)).resolves.toBe(
        0,
      );
      expect(prisma.creditTransaction.create.mock.calls).toHaveLength(0);
      expect(prisma.creditWallet.createMany.mock.calls).toHaveLength(0);
    });
  });

  describe('errors', () => {
    it('maps a unique violation from a concurrent writer to a conflict (409)', async () => {
      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.allocate({
          authId: AUTH_ID,
          source: CreditSource.REFERRAL,
          sourceReference: 'referral-1',
          credits: 5,
          now: NOW,
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });
});
