import {
  CreditSource,
  CreditTransactionType,
  Prisma,
  type CreditAllocation,
  type CreditLedgerEntry,
  type CreditSessionOverage,
  type CreditTransaction,
} from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import { CreditSettingsService } from './credit-settings.service';
import {
  CreditConflictError,
  CreditOwnerNotFoundError,
  CreditSessionNotFoundError,
  InsufficientCreditsError,
  InvalidCreditOperationError,
} from './credit-wallet.errors';
import { CreditWalletService } from './credit-wallet.service';

const D = (value: string | number) => new Prisma.Decimal(value);
const NOW = new Date('2026-11-23T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe('CreditWalletService', () => {
  const prisma = mockDeep<PrismaService>();
  const settings = mock<CreditSettingsService>();
  const service = new CreditWalletService(prisma, settings);

  /** Allocations the mocked database holds. */
  let allocations: CreditAllocation[];
  /** Order of notable calls, to check the lock comes first. */
  let calls: string[];

  const allocation = (
    overrides: Partial<CreditAllocation> = {},
  ): CreditAllocation => ({
    id: 'alloc-1',
    walletId: 'wallet-1',
    authId: 'user-1',
    source: CreditSource.PURCHASE,
    sourceReference: 'pay_1',
    amount: D(10),
    remaining: D(10),
    grantedAt: later(-24 * HOUR),
    expiresAt: null,
    subscriptionId: null,
    paymentId: null,
    periodStart: null,
    createdAt: later(-24 * HOUR),
    updatedAt: later(-24 * HOUR),
    ...overrides,
  });

  const storedTransaction = (
    overrides: Partial<CreditTransaction> = {},
    entries: Partial<CreditLedgerEntry>[] = [],
  ) => ({
    id: 'tx-1',
    sequence: BigInt(1),
    walletId: 'wallet-1',
    authId: 'user-1',
    type: CreditTransactionType.DEBIT,
    amount: D(-1),
    overageAmount: D(0),
    balanceAfter: D(9),
    idempotencyKey: 'debit:key-1',
    sessionId: null,
    description: null,
    usageCostUsd: null,
    creditCostUsdMicros: null,
    occurredAt: NOW,
    createdAt: NOW,
    ...overrides,
    entries: entries.map((entry, index) => ({
      id: `entry-${index}`,
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      allocationId: 'alloc-1',
      amount: D(-1),
      createdAt: NOW,
      ...entry,
    })),
  });

  /** A session's stored credit state (CreditSessionOverage). */
  const sessionCredit = (
    overrides: Partial<CreditSessionOverage> = {},
  ): CreditSessionOverage => ({
    id: 'ov-1',
    walletId: 'wallet-1',
    authId: 'user-1',
    sessionId: 's-1',
    overageLimit: D(5),
    overageUsed: D(0),
    reservedCredits: D(1),
    reservationRemaining: D(0),
    initializedAt: later(-HOUR / 2),
    createdAt: later(-HOUR / 2),
    updatedAt: later(-HOUR / 4),
    ...overrides,
  });

  /** The data passed to creditTransaction.create, by call. */
  const createdTransactions = () =>
    prisma.creditTransaction.create.mock.calls.map(([args]) => args.data);

  const expectNothingWritten = () => {
    expect(prisma.creditAllocation.create.mock.calls).toHaveLength(0);
    expect(prisma.creditAllocation.updateMany.mock.calls).toHaveLength(0);
    expect(prisma.creditTransaction.create.mock.calls).toHaveLength(0);
    expect(prisma.creditSessionOverage.create.mock.calls).toHaveLength(0);
    expect(prisma.creditSessionOverage.update.mock.calls).toHaveLength(0);
  };

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    allocations = [];
    calls = [];
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.authUser.findUnique.mockResolvedValue({ id: 'user-1' } as never);
    prisma.creditWallet.createMany.mockImplementation((() => {
      calls.push('ensure-wallet');
      return Promise.resolve({ count: 0 });
    }) as never);
    prisma.$queryRaw.mockImplementation((() => {
      calls.push('lock');
      return Promise.resolve([{ id: 'wallet-1' }]);
    }) as never);
    // Due-expiration lookups filter on expiresAt <= now; others do not.
    prisma.creditAllocation.findMany.mockImplementation(((args: {
      where: { expiresAt?: { lte: Date } };
    }) => {
      const due = args.where.expiresAt?.lte;
      // Fresh copies, as the database returns.
      return Promise.resolve(
        allocations
          .map((a) => ({ ...a }))
          .filter((a) =>
            due
              ? a.remaining.gt(0) &&
                a.expiresAt !== null &&
                a.expiresAt.getTime() <= due.getTime()
              : a.remaining.gt(0),
          ),
      );
    }) as never);
    prisma.creditAllocation.aggregate.mockImplementation((() =>
      Promise.resolve({
        _sum: {
          remaining: allocations.reduce<Prisma.Decimal>(
            (sum, a) => sum.plus(a.remaining),
            D(0),
          ),
        },
      })) as never);
    prisma.creditAllocation.updateMany.mockImplementation((() => {
      calls.push('update-allocation');
      return Promise.resolve({ count: 1 });
    }) as never);
    prisma.creditAllocation.create.mockImplementation(((args: {
      data: Partial<CreditAllocation>;
    }) => {
      calls.push('create-allocation');
      return Promise.resolve(allocation({ id: 'alloc-new', ...args.data }));
    }) as never);
    prisma.creditTransaction.create.mockImplementation(((args: {
      data: Partial<CreditTransaction> & {
        entries?: { create: Partial<CreditLedgerEntry>[] };
      };
    }) => {
      calls.push(`create-${String(args.data.type)}`);
      const { entries, ...data } = args.data;
      return Promise.resolve(storedTransaction(data, entries?.create ?? []));
    }) as never);
    // No session holds reserved credits unless a test says so.
    prisma.creditSessionOverage.findMany.mockResolvedValue([]);
    prisma.creditSessionOverage.aggregate.mockResolvedValue({
      _sum: { reservationRemaining: null },
    } as never);
    settings.getSettings.mockResolvedValue({
      trialCredits: 50,
      proMonthlyCredits: 1000,
      creditCostUsdMicros: 5000,
      creditCostUsd: '0.005',
      sessionOverageCredits: 5,
      deductionStepMicroCredits: 1000000,
      deductionStepCredits: '1',
      updatedAt: NOW.toISOString(),
    });
  });

  afterEach(() => jest.useRealTimers());

  describe('input validation (before any database access)', () => {
    it.each([
      ['a zero amount', { amount: 0 }],
      ['a negative amount', { amount: '-5' }],
      ['seven decimal places', { amount: '1.0000001' }],
      ['a non-numeric amount', { amount: 'lots' }],
      ['an empty source reference', { sourceReference: ' ' }],
      ['an unknown source', { source: 'BONUS' as CreditSource }],
      ['an empty user', { authId: '' }],
    ])('rejects a grant with %s', async (_case, override) => {
      await expect(
        service.grant({
          authId: 'user-1',
          source: CreditSource.PURCHASE,
          sourceReference: 'pay_1',
          amount: '10',
          ...override,
        }),
      ).rejects.toBeInstanceOf(InvalidCreditOperationError);
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });

    it.each([
      ['a zero amount', { amount: 0 }],
      ['an empty idempotency key', { idempotencyKey: '' }],
      ['an over-long idempotency key', { idempotencyKey: 'k'.repeat(201) }],
      ['an empty session', { sessionId: '  ' }],
    ])('rejects a debit with %s', async (_case, override) => {
      await expect(
        service.debit({
          authId: 'user-1',
          amount: '1',
          idempotencyKey: 'key-1',
          ...override,
        }),
      ).rejects.toBeInstanceOf(InvalidCreditOperationError);
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });

    it('rejects operations for a user that does not exist', async () => {
      prisma.authUser.findUnique.mockResolvedValue(null);
      await expect(
        service.grant({
          authId: 'ghost',
          source: CreditSource.REFERRAL,
          sourceReference: 'ref_1',
          amount: 5,
        }),
      ).rejects.toBeInstanceOf(CreditOwnerNotFoundError);
      expect(prisma.creditWallet.createMany.mock.calls).toHaveLength(0);
      expectNothingWritten();
    });
  });

  describe('grant', () => {
    it('locks the wallet, then writes the allocation, a GRANT transaction and its entry', async () => {
      allocations = [allocation({ remaining: D('2.5') })];

      const result = await service.grant({
        authId: 'user-1',
        source: CreditSource.SUBSCRIPTION,
        sourceReference: 'sub_1:2026-11-23',
        amount: '1000',
        expiresAt: later(30 * 24 * HOUR),
        payment: {
          subscriptionId: 'sub-1',
          paymentId: 'pay-1',
          periodStart: NOW,
        },
      });

      expect(calls.slice(0, 2)).toEqual(['ensure-wallet', 'lock']);
      const lockSql = (
        prisma.$queryRaw.mock.calls[0]?.[0] as unknown as string[]
      ).join('?');
      expect(lockSql).toMatch(
        /FROM "CreditWallet" WHERE "authId" = \? FOR UPDATE/,
      );
      expect(prisma.creditAllocation.create.mock.calls[0]?.[0].data).toEqual({
        walletId: 'wallet-1',
        authId: 'user-1',
        source: CreditSource.SUBSCRIPTION,
        sourceReference: 'sub_1:2026-11-23',
        amount: D(1000),
        remaining: D(1000),
        grantedAt: NOW,
        expiresAt: later(30 * 24 * HOUR),
        subscriptionId: 'sub-1',
        paymentId: 'pay-1',
        periodStart: NOW,
      });
      expect(createdTransactions()[0]).toMatchObject({
        type: CreditTransactionType.GRANT,
        amount: D(1000),
        balanceAfter: D('1002.5'),
        idempotencyKey: 'grant:SUBSCRIPTION:sub_1:2026-11-23',
        occurredAt: NOW,
        entries: { create: [{ allocationId: 'alloc-new', amount: D(1000) }] },
      });
      expect(result.replayed).toBe(false);
      expect(result.transaction.balanceAfter).toBe('1002.5');
    });

    it('returns the existing grant for a repeated source event without adding credits', async () => {
      const existing = allocation({
        id: 'alloc-pay',
        sourceReference: 'pay_9',
        amount: D('12.5'),
        remaining: D('3'),
      });
      prisma.creditAllocation.findUnique.mockResolvedValue(existing);
      prisma.creditTransaction.findUniqueOrThrow.mockResolvedValue(
        storedTransaction(
          {
            type: CreditTransactionType.GRANT,
            amount: D('12.5'),
            balanceAfter: D('12.5'),
            idempotencyKey: 'grant:PURCHASE:pay_9',
          },
          [{ allocationId: 'alloc-pay', amount: D('12.5') }],
        ) as never,
      );

      const result = await service.grant({
        authId: 'user-1',
        source: CreditSource.PURCHASE,
        sourceReference: 'pay_9',
        amount: 12.5,
      });

      expect(result).toMatchObject({
        replayed: true,
        allocation: { id: 'alloc-pay', amount: '12.5', remaining: '3' },
      });
      expectNothingWritten();
    });

    it.each([
      ['a different amount', { amount: '13' }],
      ['an expiry the original did not have', { expiresAt: later(HOUR) }],
    ])('rejects a repeated source event with %s', async (_case, override) => {
      prisma.creditAllocation.findUnique.mockResolvedValue(
        allocation({ sourceReference: 'pay_9', amount: D('12.5') }),
      );

      await expect(
        service.grant({
          authId: 'user-1',
          source: CreditSource.PURCHASE,
          sourceReference: 'pay_9',
          amount: '12.5',
          ...override,
        }),
      ).rejects.toBeInstanceOf(CreditConflictError);
      expectNothingWritten();
    });

    it('keeps the existing grant for a repeat with other values when asked to (settings changed since)', async () => {
      prisma.creditAllocation.findUnique.mockResolvedValue(
        allocation({
          id: 'alloc-trial',
          source: CreditSource.TRIAL,
          sourceReference: 'trial:1',
          amount: D(50),
          expiresAt: later(HOUR),
        }),
      );
      prisma.creditTransaction.findUniqueOrThrow.mockResolvedValue(
        storedTransaction({ type: CreditTransactionType.GRANT }) as never,
      );

      const result = await service.grant({
        authId: 'user-1',
        source: CreditSource.TRIAL,
        sourceReference: 'trial:1',
        amount: 75,
        expiresAt: later(HOUR),
        keepExistingGrant: true,
      });

      expect(result).toMatchObject({
        replayed: true,
        allocation: { id: 'alloc-trial', amount: '50' },
      });
      expectNothingWritten();
    });

    it('grants trial credits only once per user', async () => {
      prisma.creditAllocation.findFirst.mockResolvedValue({
        id: 'trial-1',
      } as never);

      await expect(
        service.grant({
          authId: 'user-1',
          source: CreditSource.TRIAL,
          sourceReference: 'another-trial',
          amount: 50,
          expiresAt: later(7 * 24 * HOUR),
        }),
      ).rejects.toThrow('Trial credits were already granted');
      expectNothingWritten();
    });

    it.each([
      [CreditSource.TRIAL, null, /require an expiration date/],
      [CreditSource.SUBSCRIPTION, later(-1), /in the future/],
      [CreditSource.PURCHASE, later(HOUR), /never expire/],
      [CreditSource.REFERRAL, later(HOUR), /never expire/],
    ])(
      'enforces the expiry rule for %s credits',
      async (source, expiresAt, message) => {
        await expect(
          service.grant({
            authId: 'user-1',
            source,
            sourceReference: 'ref',
            amount: 1,
            expiresAt,
            ...(source === CreditSource.SUBSCRIPTION
              ? {
                  payment: {
                    subscriptionId: 'sub-1',
                    paymentId: 'pay-1',
                    periodStart: later(-2),
                  },
                }
              : {}),
          }),
        ).rejects.toThrow(message);
        expectNothingWritten();
      },
    );

    it.each([
      [
        'SUBSCRIPTION credits without their payment',
        { source: CreditSource.SUBSCRIPTION, expiresAt: later(HOUR) },
        /require their payment and period/,
      ],
      [
        'SUBSCRIPTION credits whose period starts at their expiry',
        {
          source: CreditSource.SUBSCRIPTION,
          expiresAt: later(HOUR),
          payment: {
            subscriptionId: 'sub-1',
            paymentId: 'pay-1',
            periodStart: later(HOUR),
          },
        },
        /must start before/,
      ],
      [
        'purchased credits with a payment',
        {
          source: CreditSource.PURCHASE,
          payment: { subscriptionId: 's', paymentId: 'p', periodStart: NOW },
        },
        /do not belong to a payment/,
      ],
    ])(
      'rejects %s before any database access',
      async (_case, input, message) => {
        await expect(
          service.grant({
            authId: 'user-1',
            sourceReference: 'ref',
            amount: 1,
            ...input,
          }),
        ).rejects.toThrow(message);
        expect(prisma.$transaction.mock.calls).toHaveLength(0);
      },
    );

    it('does not count credits whose period has not started, but reports them as upcoming', async () => {
      prisma.creditAllocation.findMany.mockResolvedValue([
        allocation({ id: 'now', remaining: D(3) }),
        allocation({
          id: 'next-month',
          source: CreditSource.SUBSCRIPTION,
          remaining: D(1000),
          periodStart: later(HOUR),
          expiresAt: later(31 * 24 * HOUR),
        }),
      ]);

      await expect(service.getBalance('user-1')).resolves.toMatchObject({
        available: '3',
        upcoming: '1000',
        bySource: { SUBSCRIPTION: '0', PURCHASE: '3' },
      });
    });
  });

  describe('debit', () => {
    it('spends the soonest-expiring credits first, with exact fractions and one entry per allocation', async () => {
      allocations = [
        allocation({ id: 'purchase', remaining: D('10') }),
        allocation({
          id: 'trial',
          source: CreditSource.TRIAL,
          remaining: D('0.3'),
          expiresAt: later(HOUR),
        }),
      ];

      const result = await service.debit({
        authId: 'user-1',
        amount: '0.45',
        idempotencyKey: 'run-1',
      });

      expect(prisma.creditAllocation.updateMany.mock.calls).toEqual([
        [
          {
            where: { id: 'trial', remaining: { gte: D('0.3') } },
            data: { remaining: { decrement: D('0.3') } },
          },
        ],
        [
          {
            where: { id: 'purchase', remaining: { gte: D('0.15') } },
            data: { remaining: { decrement: D('0.15') } },
          },
        ],
      ]);
      expect(createdTransactions()[0]).toMatchObject({
        type: CreditTransactionType.DEBIT,
        amount: D('-0.45'),
        overageAmount: D(0),
        balanceAfter: D('9.85'),
        idempotencyKey: 'debit:run-1',
        sessionId: null,
        entries: {
          create: [
            { allocationId: 'trial', amount: D('-0.3') },
            { allocationId: 'purchase', amount: D('-0.15') },
          ],
        },
      });
      expect(result).toMatchObject({
        consumed: '0.45',
        overage: '0',
        replayed: false,
      });
    });

    it('never spends credits whose period has not started, but keeps them in balanceAfter', async () => {
      allocations = [
        allocation({ id: 'purchase', remaining: D('2') }),
        allocation({
          id: 'next-month',
          source: CreditSource.SUBSCRIPTION,
          remaining: D('1000'),
          periodStart: later(HOUR),
          expiresAt: later(31 * 24 * HOUR),
          paymentId: 'pay-2',
          subscriptionId: 'sub-1',
        }),
      ];

      await service.debit({
        authId: 'user-1',
        amount: '1.5',
        idempotencyKey: 'run-future',
      });

      expect(prisma.creditAllocation.updateMany.mock.calls).toEqual([
        [
          {
            where: { id: 'purchase', remaining: { gte: D('1.5') } },
            data: { remaining: { decrement: D('1.5') } },
          },
        ],
      ]);
      // What the wallet holds after the debit (the database checks this).
      expect(createdTransactions()[0]).toMatchObject({
        balanceAfter: D('1000.5'),
      });
    });

    it('spends only the allowed sources and records the usage cost and rate on the transaction', async () => {
      allocations = [
        allocation({
          id: 'trial',
          source: CreditSource.TRIAL,
          remaining: D(50),
          expiresAt: later(HOUR),
        }),
        allocation({ id: 'purchase', remaining: D(10) }),
      ];

      await service.debit({
        authId: 'user-1',
        amount: '5',
        idempotencyKey: 'ai-run:1',
        sources: [CreditSource.PURCHASE],
        usage: { costUsd: D('0.023'), creditCostUsdMicros: 5000 },
      });

      expect(prisma.creditAllocation.updateMany.mock.calls).toEqual([
        [
          {
            where: { id: 'purchase', remaining: { gte: D(5) } },
            data: { remaining: { decrement: D(5) } },
          },
        ],
      ]);
      expect(createdTransactions()[0]).toMatchObject({
        amount: D(-5),
        // The held balance includes the (unspendable) trial credits.
        balanceAfter: D(55),
        usageCostUsd: D('0.023'),
        creditCostUsdMicros: 5000,
      });
    });

    it('collects what the balance and the rest of the session overage cover in a partial debit', async () => {
      allocations = [allocation({ remaining: D(1) })];
      prisma.makeupSession.findFirst.mockResolvedValue({ id: 's-1' } as never);
      prisma.creditSessionOverage.findUnique.mockResolvedValue(
        sessionCredit({ overageUsed: D(4) }),
      );

      const result = await service.debit({
        authId: 'user-1',
        amount: '5',
        idempotencyKey: 'ai-run:2',
        sessionId: 's-1',
        partial: true,
      });

      expect(result).toMatchObject({
        consumed: '1',
        overage: '1',
        uncollected: '3',
      });
      expect(createdTransactions()[0]).toMatchObject({
        amount: D(-1),
        overageAmount: D(1),
      });
      expect(prisma.creditSessionOverage.update.mock.calls[0]?.[0]).toEqual({
        where: { id: 'ov-1' },
        data: {
          overageUsed: D(5),
          reservationRemaining: D(0),
        },
      });
    });

    it('collects the balance in a partial debit outside a session', async () => {
      allocations = [allocation({ remaining: D(2) })];
      await expect(
        service.debit({
          authId: 'user-1',
          amount: '5',
          idempotencyKey: 'ai-run:3',
          partial: true,
        }),
      ).resolves.toMatchObject({
        consumed: '2',
        overage: '0',
        uncollected: '3',
      });
    });

    it('rejects a partial debit when nothing at all can be collected', async () => {
      allocations = [];
      prisma.makeupSession.findFirst.mockResolvedValue({ id: 's-1' } as never);
      prisma.creditSessionOverage.findUnique.mockResolvedValue({
        id: 'ov-1',
        overageLimit: D(5),
        overageUsed: D(5),
      } as never);

      await expect(
        service.debit({
          authId: 'user-1',
          amount: '1',
          idempotencyKey: 'ai-run:4',
          sessionId: 's-1',
          partial: true,
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError);
      expectNothingWritten();
    });

    it('returns the original partial debit for a repeated key, whatever it collected', async () => {
      prisma.creditTransaction.findUnique.mockResolvedValue(
        storedTransaction({ amount: D(-2), overageAmount: D(0) }) as never,
      );

      await expect(
        service.debit({
          authId: 'user-1',
          amount: '5',
          idempotencyKey: 'ai-run:5',
          partial: true,
        }),
      ).resolves.toMatchObject({
        replayed: true,
        consumed: '2',
        uncollected: '3',
      });
      expectNothingWritten();
    });

    it('rejects a debit the balance cannot cover outside a session and writes nothing', async () => {
      allocations = [allocation({ remaining: D('0.5') })];

      const error = await service
        .debit({ authId: 'user-1', amount: '0.75', idempotencyKey: 'run-2' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(InsufficientCreditsError);
      // Same response as ProAccessGuard on POST /v1/sessions.
      expect((error as InsufficientCreditsError).getStatus()).toBe(403);
      expect((error as InsufficientCreditsError).message).toBe(
        'Insufficient credits',
      );
      expectNothingWritten();
    });

    it("covers an initialized session's shortfall from its overage allowance, never going negative", async () => {
      allocations = [allocation({ remaining: D('1') })];
      prisma.makeupSession.findFirst.mockResolvedValue({ id: 's-1' } as never);
      prisma.creditSessionOverage.findUnique.mockResolvedValue(
        sessionCredit({ reservationRemaining: D(1) }),
      );

      const result = await service.debit({
        authId: 'user-1',
        amount: '3.5',
        idempotencyKey: 'run-3',
        sessionId: 's-1',
      });

      expect(prisma.makeupSession.findFirst.mock.calls[0]?.[0]).toEqual({
        where: { id: 's-1', authId: 'user-1' },
        select: { id: true },
      });
      // The limit is the one fixed at initialization; nothing is created.
      expect(prisma.creditSessionOverage.create.mock.calls).toHaveLength(0);
      expect(prisma.creditSessionOverage.update.mock.calls[0]?.[0]).toEqual({
        where: { id: 'ov-1' },
        data: {
          overageUsed: D('2.5'),
          reservationRemaining: D(0),
        },
      });
      expect(createdTransactions()[0]).toMatchObject({
        amount: D(-1),
        overageAmount: D('2.5'),
        balanceAfter: D(0),
        sessionId: 's-1',
      });
      expect(result).toMatchObject({ consumed: '1', overage: '2.5' });
    });

    it('keeps the limit recorded for the session even if the setting changed since', async () => {
      prisma.makeupSession.findFirst.mockResolvedValue({ id: 's-1' } as never);
      prisma.creditSessionOverage.findUnique.mockResolvedValue(
        sessionCredit({ overageUsed: D('4.5') }),
      );
      settings.getSettings.mockResolvedValue({
        sessionOverageCredits: 100,
      } as never);

      await expect(
        service.debit({
          authId: 'user-1',
          amount: '0.6',
          idempotencyKey: 'run-4',
          sessionId: 's-1',
        }),
      ).rejects.toMatchObject({
        response: {
          errors: expect.objectContaining({
            code: 'INSUFFICIENT_CREDITS',
            overageRemaining: '0.5',
          }) as unknown,
        },
      });
      expect(settings.getSettings.mock.calls).toHaveLength(0);
      expectNothingWritten();
    });

    it("rejects a session that is not the user's", async () => {
      prisma.makeupSession.findFirst.mockResolvedValue(null);

      await expect(
        service.debit({
          authId: 'user-1',
          amount: '1',
          idempotencyKey: 'run-5',
          sessionId: 'someone-elses',
        }),
      ).rejects.toBeInstanceOf(CreditSessionNotFoundError);
      expectNothingWritten();
    });

    it('returns the original debit for a repeated idempotency key', async () => {
      prisma.creditTransaction.findUnique.mockResolvedValue(
        storedTransaction({
          amount: D('-1.5'),
          overageAmount: D('0.5'),
          sessionId: 's-1',
        }) as never,
      );

      const result = await service.debit({
        authId: 'user-1',
        amount: '2',
        idempotencyKey: 'key-1',
        sessionId: 's-1',
      });

      expect(
        prisma.creditTransaction.findUnique.mock.calls[0]?.[0],
      ).toMatchObject({
        where: {
          walletId_idempotencyKey: {
            walletId: 'wallet-1',
            idempotencyKey: 'debit:key-1',
          },
        },
      });
      expect(result).toMatchObject({
        replayed: true,
        consumed: '1.5',
        overage: '0.5',
      });
      expectNothingWritten();
    });

    it.each([
      ['a different amount', { amount: '3', sessionId: 's-1' }],
      ['a different session', { amount: '2', sessionId: undefined }],
    ])(
      'rejects a repeated idempotency key with %s',
      async (_case, override) => {
        prisma.creditTransaction.findUnique.mockResolvedValue(
          storedTransaction({
            amount: D('-1.5'),
            overageAmount: D('0.5'),
            sessionId: 's-1',
          }) as never,
        );

        await expect(
          service.debit({
            authId: 'user-1',
            idempotencyKey: 'key-1',
            ...override,
          }),
        ).rejects.toBeInstanceOf(CreditConflictError);
        expectNothingWritten();
      },
    );
  });

  describe('expiration', () => {
    it('records expirations under the lock before a debit, so expired credits are never spent', async () => {
      allocations = [
        allocation({
          id: 'trial',
          source: CreditSource.TRIAL,
          remaining: D('7.25'),
          expiresAt: later(-HOUR),
        }),
        allocation({ id: 'purchase', remaining: D('2') }),
      ];
      prisma.creditAllocation.updateMany.mockImplementation(((args: {
        where: { id: string };
        data: { remaining: unknown };
      }) => {
        calls.push('update-allocation');
        if (args.data.remaining === 0) {
          const expired = allocations.find((a) => a.id === args.where.id);
          if (expired) expired.remaining = D(0);
        }
        return Promise.resolve({ count: 1 });
      }) as never);

      await service.debit({
        authId: 'user-1',
        amount: '1',
        idempotencyKey: 'run-6',
      });

      const [expiration, debit] = createdTransactions();
      expect(expiration).toMatchObject({
        type: CreditTransactionType.EXPIRATION,
        amount: D('-7.25'),
        balanceAfter: D(2),
        idempotencyKey: 'expire:trial',
        occurredAt: later(-HOUR),
        entries: { create: [{ allocationId: 'trial', amount: D('-7.25') }] },
      });
      expect(debit).toMatchObject({
        type: CreditTransactionType.DEBIT,
        amount: D(-1),
        balanceAfter: D(1),
        entries: { create: [{ allocationId: 'purchase', amount: D(-1) }] },
      });
      expect(calls.indexOf('lock')).toBeLessThan(
        calls.indexOf('create-EXPIRATION'),
      );
    });
  });

  describe("in the caller's transaction", () => {
    it('grants inside the given transaction without opening another', async () => {
      const outer = mockDeep<PrismaService>();
      outer.authUser.findUnique.mockResolvedValue({ id: 'user-1' } as never);
      outer.creditWallet.createMany.mockResolvedValue({ count: 1 });
      outer.$queryRaw.mockResolvedValue([{ id: 'wallet-1' }] as never);
      outer.creditAllocation.findMany.mockResolvedValue([]);
      outer.creditAllocation.findUnique.mockResolvedValue(null);
      outer.creditAllocation.findFirst.mockResolvedValue(null);
      outer.creditAllocation.aggregate.mockResolvedValue({
        _sum: { remaining: null },
      } as never);
      outer.creditAllocation.create.mockResolvedValue(
        allocation({ id: 'alloc-trial', source: CreditSource.TRIAL }),
      );
      outer.creditTransaction.create.mockResolvedValue(
        storedTransaction({ type: CreditTransactionType.GRANT }) as never,
      );
      outer.creditSessionOverage.findMany.mockResolvedValue([]);

      await service.grant(
        {
          authId: 'user-1',
          source: CreditSource.TRIAL,
          sourceReference: 'trial:1',
          amount: 50,
          expiresAt: later(7 * 24 * HOUR),
        },
        { tx: outer },
      );

      expect(prisma.$transaction.mock.calls).toHaveLength(0);
      expect(outer.$queryRaw.mock.calls).toHaveLength(1);
      expect(outer.creditAllocation.create.mock.calls).toHaveLength(1);
      expect(prisma.creditAllocation.create.mock.calls).toHaveLength(0);
    });
  });

  describe('makeup sessions (reservation and overage)', () => {
    const reservedByOthers = (amount: string) =>
      prisma.creditSessionOverage.aggregate.mockResolvedValue({
        _sum: { reservationRemaining: D(amount) },
      } as never);

    beforeEach(() => {
      prisma.makeupSession.findFirst.mockResolvedValue({ id: 's-1' } as never);
      prisma.creditSessionOverage.findUnique.mockResolvedValue(null);
      prisma.creditSessionOverage.create.mockImplementation(((args: {
        data: Partial<CreditSessionOverage>;
      }) => {
        calls.push('initialize-session');
        return Promise.resolve(sessionCredit(args.data));
      }) as never);
      prisma.creditSessionOverage.update.mockImplementation(((args: {
        data: Partial<CreditSessionOverage>;
      }) => Promise.resolve(sessionCredit(args.data))) as never);
    });

    it('initializes a session under the wallet lock, reserving one free credit and fixing the overage limit', async () => {
      allocations = [allocation({ remaining: D('3.5') })];
      reservedByOthers('1');

      const view = await service.initializeSession({
        authId: 'user-1',
        sessionId: 's-1',
      });

      expect(calls.indexOf('lock')).toBeLessThan(
        calls.indexOf('initialize-session'),
      );
      // Reservations of the user's other sessions are not free.
      expect(prisma.creditSessionOverage.aggregate.mock.calls[0]?.[0]).toEqual({
        where: {
          walletId: 'wallet-1',
          sessionId: { not: 's-1' },
        },
        _sum: { reservationRemaining: true },
      });
      expect(
        prisma.creditSessionOverage.create.mock.calls[0]?.[0].data,
      ).toEqual({
        walletId: 'wallet-1',
        authId: 'user-1',
        sessionId: 's-1',
        overageLimit: D(5),
        reservedCredits: D(1),
        reservationRemaining: D(1),
        initializedAt: NOW,
      });
      expect(view).toMatchObject({
        freeCredits: '2.5',
        initialized: true,
        reservedCredits: '1',
        overageLimit: '5',
        overageRemaining: '5',
      });
    });

    it('reserves what is free when that is less than one credit', async () => {
      allocations = [allocation({ remaining: D('0.4') })];

      await service.initializeSession({ authId: 'user-1', sessionId: 's-1' });

      expect(
        prisma.creditSessionOverage.create.mock.calls[0]?.[0].data,
      ).toMatchObject({
        reservedCredits: D('0.4'),
        reservationRemaining: D('0.4'),
      });
    });

    it.each([
      ['no credits at all', '0', '0'],
      ['credits that other sessions have reserved', '1', '1'],
      ['credits that other sessions have more than reserved', '0.5', '1'],
    ])(
      'refuses to initialize a session with %s (403 "Insufficient credits")',
      async (_case, balance, reserved) => {
        allocations =
          balance === '0' ? [] : [allocation({ remaining: D(balance) })];
        reservedByOthers(reserved);

        await expect(
          service.initializeSession({ authId: 'user-1', sessionId: 's-1' }),
        ).rejects.toMatchObject({
          status: 403,
          message: 'Insufficient credits',
        });
        expectNothingWritten();
      },
    );

    it('counts only the given credit sources when initializing', async () => {
      allocations = [allocation({ remaining: D(5) })];
      await service.initializeSession({
        authId: 'user-1',
        sessionId: 's-1',
        sources: [CreditSource.PURCHASE],
      });
      expect(prisma.creditAllocation.findMany.mock.calls.at(-1)?.[0]).toEqual({
        where: {
          walletId: 'wallet-1',
          remaining: { gt: 0 },
          source: { in: [CreditSource.PURCHASE] },
        },
      });
    });

    it("refuses a session that is not the user's", async () => {
      prisma.makeupSession.findFirst.mockResolvedValue(null);
      await expect(
        service.initializeSession({ authId: 'user-1', sessionId: 's-2' }),
      ).rejects.toBeInstanceOf(CreditSessionNotFoundError);
      expectNothingWritten();
    });

    it('changes nothing when an initialized session is initialized again', async () => {
      allocations = [];
      prisma.creditSessionOverage.findUnique.mockResolvedValue(
        sessionCredit({
          reservationRemaining: D('0.3'),
          reservedCredits: D(1),
        }),
      );

      await service.initializeSession({ authId: 'user-1', sessionId: 's-1' });

      expectNothingWritten();
    });

    describe('before an AI request (prepareSessionUse)', () => {
      it('lets an initialized session without free credits use its overage', async () => {
        allocations = [];
        const stored = sessionCredit({ overageUsed: D('4.9') });
        prisma.creditSessionOverage.findUnique.mockResolvedValue(stored);
        prisma.creditSessionOverage.update.mockResolvedValue(stored);
        await expect(
          service.prepareSessionUse({ authId: 'user-1', sessionId: 's-1' }),
        ).resolves.toMatchObject({
          freeCredits: '0',
          overageRemaining: '0.1',
          initialized: false,
        });
      });

      it('refuses an initialized session with neither free credits nor overage left', async () => {
        allocations = [allocation({ remaining: D(1) })];
        reservedByOthers('1');
        prisma.creditSessionOverage.findUnique.mockResolvedValue(
          sessionCredit({ overageUsed: D(5) }),
        );
        await expect(
          service.prepareSessionUse({ authId: 'user-1', sessionId: 's-1' }),
        ).rejects.toMatchObject({
          response: {
            errors: expect.objectContaining({
              code: 'INSUFFICIENT_CREDITS',
              available: '0',
              overageRemaining: '0',
            }) as unknown,
          },
        });
        expectNothingWritten();
      });

      it('initializes a session that never was (created before credits) if credits are free', async () => {
        allocations = [allocation({ remaining: D(2) })];
        await expect(
          service.prepareSessionUse({ authId: 'user-1', sessionId: 's-1' }),
        ).resolves.toMatchObject({ initialized: true, reservedCredits: '1' });
      });

      it('gives a session that never was initialized no overage without free credits', async () => {
        allocations = [];
        await expect(
          service.prepareSessionUse({ authId: 'user-1', sessionId: 's-1' }),
        ).rejects.toBeInstanceOf(InsufficientCreditsError);
        expectNothingWritten();
      });
    });

    describe('debits', () => {
      it("never spend credits reserved by the user's other sessions", async () => {
        allocations = [allocation({ remaining: D('1.5') })];
        reservedByOthers('1');

        await expect(
          service.debit({ authId: 'user-1', amount: '1', idempotencyKey: 'k' }),
        ).rejects.toMatchObject({
          response: {
            errors: expect.objectContaining({ available: '0.5' }) as unknown,
          },
        });
        expectNothingWritten();
      });

      it('use the free balance, then the overage, and reduce the session reservation', async () => {
        allocations = [allocation({ remaining: D(2) })];
        reservedByOthers('1');
        prisma.creditSessionOverage.findUnique.mockResolvedValue(
          sessionCredit({ reservationRemaining: D(1) }),
        );

        const result = await service.debit({
          authId: 'user-1',
          amount: '0.25',
          idempotencyKey: 'k',
          sessionId: 's-1',
        });

        expect(result).toMatchObject({ consumed: '0.25', overage: '0' });
        expect(prisma.creditSessionOverage.update.mock.calls[0]?.[0]).toEqual({
          where: { id: 'ov-1' },
          data: {
            overageUsed: D(0),
            reservationRemaining: D('0.75'),
          },
        });
      });

      it('give a session that is not initialized no overage', async () => {
        allocations = [allocation({ remaining: D(1) })];
        prisma.creditSessionOverage.findUnique.mockResolvedValue(null);

        await expect(
          service.debit({
            authId: 'user-1',
            amount: '2',
            idempotencyKey: 'k',
            sessionId: 's-1',
          }),
        ).rejects.toMatchObject({
          response: {
            errors: expect.objectContaining({
              overageRemaining: '0',
            }) as unknown,
          },
        });
        expectNothingWritten();
      });
    });

    it('reduces the reservations of unfinished sessions to the credits left once credits expired', async () => {
      // The only credits (1) expired; the unfinished session had reserved 1.
      allocations = [
        allocation({
          remaining: D(1),
          expiresAt: later(-HOUR),
          source: CreditSource.TRIAL,
        }),
      ];
      prisma.creditSessionOverage.findMany.mockResolvedValue([
        sessionCredit({
          id: 'open',
          sessionId: 's-open',
          reservationRemaining: D(1),
        }),
      ]);
      prisma.makeupSession.findMany.mockResolvedValue([
        { id: 's-open' },
      ] as never);

      prisma.creditWallet.findUnique.mockResolvedValue({
        id: 'wallet-1',
      } as never);
      await service.expireCredits('user-1');

      expect(prisma.creditSessionOverage.update.mock.calls.at(-1)?.[0]).toEqual(
        {
          where: { id: 'open' },
          data: { reservationRemaining: D(0) },
        },
      );
    });

    it('releases reservations of completed or deleted sessions under the lock, never those of unfinished ones', async () => {
      allocations = [allocation({ remaining: D(5) })];
      prisma.creditSessionOverage.findMany.mockImplementation((() => {
        calls.push('find-reservations');
        return Promise.resolve([
          sessionCredit({
            id: 'done',
            sessionId: 's-done',
            reservationRemaining: D(1),
          }),
          sessionCredit({
            id: 'gone',
            sessionId: 's-gone',
            reservationRemaining: D(1),
          }),
          // Unfinished, and idle for days: keeps its reservation.
          sessionCredit({
            id: 'idle',
            sessionId: 's-idle',
            reservationRemaining: D('0.5'),
            initializedAt: later(-72 * HOUR),
            updatedAt: later(-72 * HOUR),
          }),
          sessionCredit({
            id: 'busy',
            sessionId: 's-busy',
            reservationRemaining: D(1),
          }),
        ]);
      }) as never);
      // s-done is COMPLETED and s-gone deleted: only these are open.
      prisma.makeupSession.findMany.mockResolvedValue([
        { id: 's-idle' },
        { id: 's-busy' },
      ] as never);

      await service.debit({
        authId: 'user-1',
        amount: '1',
        idempotencyKey: 'k',
      });

      expect(calls.indexOf('lock')).toBeLessThan(
        calls.indexOf('find-reservations'),
      );
      expect(prisma.makeupSession.findMany.mock.calls[0]?.[0]).toEqual({
        where: {
          id: { in: ['s-done', 's-gone', 's-idle', 's-busy'] },
          authId: 'user-1',
          status: { not: 'COMPLETED' },
        },
        select: { id: true },
      });
      expect(prisma.creditSessionOverage.updateMany.mock.calls).toEqual([
        [
          {
            where: { id: { in: ['done', 'gone'] } },
            data: { reservationRemaining: 0 },
          },
        ],
      ]);
    });
  });

  describe('expireSourceNow', () => {
    it('closes every open allocation of the source, now, with the given description', async () => {
      prisma.creditWallet.findUnique.mockResolvedValue({
        id: 'wallet-1',
      } as never);
      allocations = [
        allocation({
          id: 'trial',
          source: CreditSource.TRIAL,
          remaining: D('37.5'),
          expiresAt: later(5 * 24 * HOUR),
        }),
        allocation({ id: 'purchase', remaining: D('20') }),
      ];
      prisma.creditAllocation.findMany.mockImplementation(((args: {
        where: { source?: CreditSource; expiresAt?: unknown };
      }) =>
        Promise.resolve(
          args.where.expiresAt
            ? []
            : allocations.filter((a) => a.source === args.where.source),
        )) as never);

      await expect(
        service.expireSourceNow('user-1', CreditSource.TRIAL, 'upgraded'),
      ).resolves.toBe(1);

      expect(createdTransactions()).toEqual([
        expect.objectContaining({
          type: CreditTransactionType.EXPIRATION,
          amount: D('-37.5'),
          balanceAfter: D('20'),
          idempotencyKey: 'expire:trial',
          description: 'upgraded',
          occurredAt: NOW,
          entries: { create: [{ allocationId: 'trial', amount: D('-37.5') }] },
        }),
      ]);
      expect(prisma.creditAllocation.updateMany.mock.calls).toEqual([
        [
          {
            where: { id: 'trial', remaining: D('37.5') },
            data: { remaining: 0 },
          },
        ],
      ]);
    });

    it("expires only one payment's credits, now (a refund)", async () => {
      prisma.creditWallet.findUnique.mockResolvedValue({
        id: 'wallet-1',
      } as never);
      allocations = [
        allocation({
          id: 'month-1',
          source: CreditSource.SUBSCRIPTION,
          remaining: D('990'),
          expiresAt: later(20 * 24 * HOUR),
          paymentId: 'pay-1',
        }),
        allocation({
          id: 'month-2',
          source: CreditSource.SUBSCRIPTION,
          remaining: D('1000'),
          expiresAt: later(50 * 24 * HOUR),
          paymentId: 'pay-2',
        }),
      ];
      prisma.creditAllocation.findMany.mockImplementation(((args: {
        where: { paymentId?: string; expiresAt?: unknown };
      }) =>
        Promise.resolve(
          args.where.expiresAt
            ? []
            : allocations.filter((a) => a.paymentId === args.where.paymentId),
        )) as never);

      await expect(
        service.expirePaymentCreditsNow('user-1', 'pay-1', 'refunded'),
      ).resolves.toBe(1);
      expect(createdTransactions()).toEqual([
        expect.objectContaining({
          type: CreditTransactionType.EXPIRATION,
          amount: D('-990'),
          balanceAfter: D('1000'),
          description: 'refunded',
          occurredAt: NOW,
        }),
      ]);
    });

    it('creates no wallet for a user who has none', async () => {
      prisma.creditWallet.findUnique.mockResolvedValue(null);

      await expect(
        service.expireSourceNow('user-1', CreditSource.TRIAL, 'upgraded'),
      ).resolves.toBe(0);
      expect(prisma.creditWallet.createMany.mock.calls).toHaveLength(0);
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });
  });

  describe('expireDueCredits', () => {
    it('processes every due wallet, oldest expiry first, and skips wallets that fail', async () => {
      prisma.creditAllocation.findMany.mockResolvedValueOnce([
        { authId: 'gone' },
        { authId: 'user-1' },
      ] as never);
      const expireCredits = jest
        .spyOn(service, 'expireCredits')
        .mockRejectedValueOnce(new CreditOwnerNotFoundError())
        .mockResolvedValueOnce(2);

      await expect(service.expireDueCredits({ limit: 10 })).resolves.toEqual({
        wallets: 2,
        expirations: 2,
        failed: 1,
      });
      expect(prisma.creditAllocation.findMany.mock.calls[0]?.[0]).toEqual({
        where: { remaining: { gt: 0 }, expiresAt: { lte: NOW } },
        select: { authId: true },
        distinct: ['authId'],
        orderBy: { expiresAt: 'asc' },
        take: 10,
      });
      expect(expireCredits.mock.calls).toEqual([['gone'], ['user-1']]);
      expireCredits.mockRestore();
    });
  });

  describe('hasGrant', () => {
    it('looks up the source event for the user only', async () => {
      prisma.creditAllocation.findFirst.mockResolvedValue(null);
      await expect(
        service.hasGrant('user-1', CreditSource.SUBSCRIPTION, 'pro:1'),
      ).resolves.toBe(false);
      expect(prisma.creditAllocation.findFirst.mock.calls[0]?.[0]).toEqual({
        where: {
          authId: 'user-1',
          source: CreditSource.SUBSCRIPTION,
          sourceReference: 'pro:1',
        },
        select: { id: true },
      });
    });
  });

  describe('getBalance', () => {
    it('excludes expired credits even before their expiration is recorded', async () => {
      prisma.creditAllocation.findMany.mockResolvedValue([
        allocation({
          id: 'sub',
          source: CreditSource.SUBSCRIPTION,
          remaining: D('999.5'),
          expiresAt: later(2 * HOUR),
        }),
        allocation({
          id: 'trial-a',
          source: CreditSource.TRIAL,
          remaining: D('0.25'),
          expiresAt: later(HOUR),
        }),
        allocation({
          id: 'ref',
          source: CreditSource.REFERRAL,
          remaining: D('5'),
        }),
        // Returned by a stale query; must still not count.
        allocation({
          id: 'expired',
          source: CreditSource.TRIAL,
          remaining: D(40),
          expiresAt: NOW,
        }),
      ]);

      const balance = await service.getBalance('user-1');

      expect(prisma.creditAllocation.findMany.mock.calls[0]?.[0]).toEqual({
        where: {
          authId: 'user-1',
          remaining: { gt: 0 },
          OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
        },
      });
      expect(balance).toMatchObject({
        available: '1004.75',
        bySource: {
          TRIAL: '0.25',
          SUBSCRIPTION: '999.5',
          PURCHASE: '0',
          REFERRAL: '5',
        },
        nextExpiration: {
          expiresAt: later(HOUR).toISOString(),
          amount: '0.25',
        },
      });
      expect(balance.allocations.map((a) => a.id)).toEqual([
        'trial-a',
        'sub',
        'ref',
      ]);
      expect(prisma.$transaction.mock.calls).toHaveLength(0);
    });
  });
});
