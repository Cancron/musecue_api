import {
  CreditSource,
  CreditTransactionType,
  Prisma,
  type CreditAllocation,
  type CreditLedgerEntry,
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
    settings.getSettings.mockResolvedValue({
      trialCredits: 50,
      proMonthlyCredits: 1000,
      creditCostUsdMicros: 5000,
      creditCostUsd: '0.005',
      sessionOverageCredits: 5,
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
          }),
        ).rejects.toThrow(message);
        expectNothingWritten();
      },
    );
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

    it('rejects a debit the balance cannot cover outside a session and writes nothing', async () => {
      allocations = [allocation({ remaining: D('0.5') })];

      const error = await service
        .debit({ authId: 'user-1', amount: '0.75', idempotencyKey: 'run-2' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(InsufficientCreditsError);
      expect((error as InsufficientCreditsError).getStatus()).toBe(402);
      expectNothingWritten();
    });

    it('covers a session shortfall from the overage allowance, snapshotting the configured limit', async () => {
      allocations = [allocation({ remaining: D('1') })];
      prisma.makeupSession.findFirst.mockResolvedValue({ id: 's-1' } as never);
      prisma.creditSessionOverage.findUnique.mockResolvedValue(null);

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
      expect(
        prisma.creditSessionOverage.create.mock.calls[0]?.[0].data,
      ).toEqual({
        walletId: 'wallet-1',
        authId: 'user-1',
        sessionId: 's-1',
        overageLimit: D(5),
        overageUsed: D('2.5'),
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
      prisma.creditSessionOverage.findUnique.mockResolvedValue({
        id: 'ov-1',
        overageLimit: D(5),
        overageUsed: D('4.5'),
      } as never);
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
