import { PrismaPg } from '@prisma/adapter-pg';
import {
  BillingInterval,
  CreditSource,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { CreditExpirationSweepService } from '../src/credits/credit-expiration-sweep.service';
import { CreditSettingsService } from '../src/credits/credit-settings.service';
import {
  CreditConflictError,
  InsufficientCreditsError,
} from '../src/credits/credit-wallet.errors';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import { freezeTime } from './support/freeze-time';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import {
  createUser,
  givenPaidProHistory,
} from './support/subscription-fixtures';

jest.setTimeout(120_000);

const D = (value: string | number) => new Prisma.Decimal(value);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The credit wallet and ledger against a real, fully migrated PostgreSQL
 * schema: ownership, sources and expiry, exact fractional amounts,
 * concurrency (row locks and unique keys), and the database rules that keep
 * the history append-only and the balances consistent. No external service.
 */
describeWithDatabase('Credit wallet and ledger (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  let wallet: CreditWalletService;
  let settings: CreditSettingsService;

  const grantPurchase = (
    authId: string,
    amount: string,
    ref = `pay_${amount}`,
  ) =>
    wallet.grant({
      authId,
      source: CreditSource.PURCHASE,
      sourceReference: ref,
      amount,
    });

  /**
   * A paid month of Pro for the user (record, SUCCEEDED payment and CREATED
   * event, as the Stripe webhook writes them): monthly Pro credits must
   * belong to such a payment. Returns the link for `grant({ payment })`.
   */
  const paidMonth = async (authId: string, startedAt: Date) => {
    await givenPaidProHistory(
      client,
      authId,
      { billingInterval: BillingInterval.MONTHLY, startedAt },
      startedAt,
    );
    const { id, payments } = await client.userSubscription.findUniqueOrThrow({
      where: { authId },
      include: { payments: true },
    });
    return {
      link: {
        subscriptionId: id,
        paymentId: payments[0].id,
        periodStart: payments[0].periodStart,
      },
      periodEnd: payments[0].periodEnd,
    };
  };

  /**
   * Re-checks every ledger invariant from the stored rows:
   * entries add up to each allocation's remaining credits and to each
   * transaction's amount; balanceAfter forms a gap-free chain; the latest
   * balanceAfter equals the wallet's remaining credits; nothing is negative.
   */
  const expectConsistentLedger = async (authId: string) => {
    const allocations = await client.creditAllocation.findMany({
      where: { authId },
      include: { entries: true },
    });
    for (const allocation of allocations) {
      const entries = allocation.entries.reduce(
        (sum, entry) => sum.plus(entry.amount),
        D(0),
      );
      expect(allocation.remaining.toFixed()).toBe(entries.toFixed());
      expect(allocation.remaining.gte(0)).toBe(true);
      expect(allocation.remaining.lte(allocation.amount)).toBe(true);
    }
    const transactions = await client.creditTransaction.findMany({
      where: { authId },
      orderBy: { sequence: 'asc' },
      include: { entries: true },
    });
    let balance = D(0);
    for (const transaction of transactions) {
      const entries = transaction.entries.reduce(
        (sum, entry) => sum.plus(entry.amount),
        D(0),
      );
      expect(transaction.amount.toFixed()).toBe(entries.toFixed());
      balance = balance.plus(transaction.amount);
      expect(transaction.balanceAfter.toFixed()).toBe(balance.toFixed());
      expect(transaction.balanceAfter.gte(0)).toBe(true);
    }
    const remaining = allocations.reduce(
      (sum, allocation) => sum.plus(allocation.remaining),
      D(0),
    );
    expect(balance.toFixed()).toBe(remaining.toFixed());
    return { allocations, transactions, remaining };
  };

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    client = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: TEST_DATABASE_URL as string,
          options: `-c search_path=${schema}`,
        },
        { schema },
      ),
    });
    const prisma = client as unknown as PrismaService;
    const logger = mock<CustomLoggerService>();
    settings = new CreditSettingsService(
      prisma,
      new ActivityLogService(prisma, logger),
      logger,
    );
    wallet = new CreditWalletService(prisma, settings);
  });

  afterAll(async () => {
    jest.useRealTimers();
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
  });

  afterEach(() => jest.useRealTimers());

  describe('allocations belong to the right user and source', () => {
    it('creates one wallet per user and attaches each allocation to its user and source', async () => {
      const alice = await createUser(client);
      const bob = await createUser(client);
      const now = Date.now();

      await wallet.grant({
        authId: alice,
        source: CreditSource.TRIAL,
        sourceReference: 'trial',
        amount: 50,
        expiresAt: new Date(now + 7 * DAY),
      });
      await wallet.grant({
        authId: alice,
        source: CreditSource.REFERRAL,
        sourceReference: 'ref_1',
        amount: '2.5',
      });
      const bobPaid = await paidMonth(bob, new Date(now));
      await wallet.grant({
        authId: bob,
        source: CreditSource.SUBSCRIPTION,
        sourceReference: 'sub_1:2026-11',
        amount: 1000,
        expiresAt: bobPaid.periodEnd,
        payment: bobPaid.link,
      });

      const wallets = await client.creditWallet.findMany({
        where: { authId: { in: [alice, bob] } },
      });
      expect(wallets).toHaveLength(2);
      const walletOf = (authId: string) =>
        wallets.find((w) => w.authId === authId)?.id;
      const rows = await client.creditAllocation.findMany({
        where: { authId: { in: [alice, bob] } },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        rows.map((row) => [
          row.authId,
          row.walletId,
          row.source,
          row.amount.toFixed(),
          row.expiresAt === null,
        ]),
      ).toEqual([
        [alice, walletOf(alice), 'TRIAL', '50', false],
        [alice, walletOf(alice), 'REFERRAL', '2.5', true],
        [bob, walletOf(bob), 'SUBSCRIPTION', '1000', false],
      ]);
      await expect(wallet.getBalance(alice)).resolves.toMatchObject({
        available: '52.5',
        bySource: { TRIAL: '50', REFERRAL: '2.5', SUBSCRIPTION: '0' },
      });
      await expect(wallet.getBalance(bob)).resolves.toMatchObject({
        available: '1000',
      });
      await expectConsistentLedger(alice);
      await expectConsistentLedger(bob);
    });

    it("refuses to attach an allocation to another user's wallet", async () => {
      const alice = await createUser(client);
      const bob = await createUser(client);
      await grantPurchase(alice, '1');
      const aliceWallet = await client.creditWallet.findUniqueOrThrow({
        where: { authId: alice },
      });

      await expect(
        client.creditAllocation.create({
          data: {
            walletId: aliceWallet.id,
            authId: bob,
            source: CreditSource.PURCHASE,
            sourceReference: 'stolen',
            amount: 5,
            remaining: 5,
            grantedAt: new Date(),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('enforces expiry by source and one trial per user in the database itself', async () => {
      const userId = await createUser(client);
      await grantPurchase(userId, '1');
      const { id: walletId } = await client.creditWallet.findUniqueOrThrow({
        where: { authId: userId },
      });
      const base = {
        walletId,
        authId: userId,
        amount: 1,
        remaining: 1,
        grantedAt: new Date(),
      };
      const future = new Date(Date.now() + DAY);
      // A valid payment link, so the SUBSCRIPTION row reaches the CHECK.
      const { link } = await paidMonth(userId, new Date(Date.now() - DAY));

      for (const [data, constraint] of [
        [
          {
            source: CreditSource.PURCHASE,
            sourceReference: 'p',
            expiresAt: future,
          },
          'CreditAllocation_expiry_by_source',
        ],
        [
          {
            source: CreditSource.REFERRAL,
            sourceReference: 'r',
            expiresAt: future,
          },
          'CreditAllocation_expiry_by_source',
        ],
        [
          { source: CreditSource.TRIAL, sourceReference: 't', expiresAt: null },
          'CreditAllocation_expiry_by_source',
        ],
        [
          {
            source: CreditSource.SUBSCRIPTION,
            sourceReference: 's',
            expiresAt: null,
            ...link,
          },
          'CreditAllocation_expiry_by_source',
        ],
        [
          {
            source: CreditSource.PURCHASE,
            sourceReference: 'neg',
            amount: -1,
            remaining: -1,
          },
          'CreditAllocation_amount_positive',
        ],
      ] as const) {
        await expect(
          client.$transaction((tx) =>
            tx.creditAllocation.create({ data: { ...base, ...data } }),
          ),
        ).rejects.toThrow(constraint);
      }

      await wallet.grant({
        authId: userId,
        source: CreditSource.TRIAL,
        sourceReference: 'trial-a',
        amount: 50,
        expiresAt: future,
      });
      await expect(
        client.$transaction((tx) =>
          tx.creditAllocation.create({
            data: {
              ...base,
              source: CreditSource.TRIAL,
              sourceReference: 'trial-b',
              expiresAt: future,
            },
          }),
        ),
        // Partial unique index CreditAllocation_one_trial_per_wallet.
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('fractional amounts', () => {
    it('keeps fractional balances and transactions exact', async () => {
      const userId = await createUser(client);
      for (const [index, amount] of ['0.1', '0.2', '0.000001'].entries()) {
        await grantPurchase(userId, amount, `frac_${index}`);
      }
      await expect(wallet.getBalance(userId)).resolves.toMatchObject({
        available: '0.300001',
      });

      await wallet.debit({
        authId: userId,
        amount: '0.3',
        idempotencyKey: 'd1',
      });
      await expect(wallet.getBalance(userId)).resolves.toMatchObject({
        available: '0.000001',
      });
      await wallet.debit({
        authId: userId,
        amount: '0.000001',
        idempotencyKey: 'd2',
      });
      await expect(wallet.getBalance(userId)).resolves.toMatchObject({
        available: '0',
      });

      const history = await wallet.listTransactions(userId);
      expect(history.map((t) => [t.type, t.amount, t.balanceAfter])).toEqual([
        ['DEBIT', '-0.000001', '0'],
        ['DEBIT', '-0.3', '0.000001'],
        ['GRANT', '0.000001', '0.300001'],
        ['GRANT', '0.2', '0.3'],
        ['GRANT', '0.1', '0.1'],
      ]);
      await expectConsistentLedger(userId);
    });

    it('stores amounts as NUMERIC(18, 6) and rejects more precision instead of rounding', async () => {
      const userId = await createUser(client);
      await expect(grantPurchase(userId, '0.0000001')).rejects.toThrow(
        'at most 6 decimal places',
      );
      await expect(
        client.creditWallet.count({ where: { authId: userId } }),
      ).resolves.toBe(0);

      const rows = await client.$queryRawUnsafe<
        {
          data_type: string;
          numeric_precision: number;
          numeric_scale: number;
        }[]
      >(
        `SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'CreditAllocation' AND column_name = 'remaining'`,
      );
      expect(rows).toEqual([
        { data_type: 'numeric', numeric_precision: 18, numeric_scale: 6 },
      ]);
    });
  });

  describe('concurrency', () => {
    it('applies the same grant once when it is delivered many times concurrently', async () => {
      const userId = await createUser(client);
      // One delivery's values, computed once: every retry carries the same.
      const paid = await paidMonth(userId, new Date());
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          wallet.grant({
            authId: userId,
            source: CreditSource.SUBSCRIPTION,
            sourceReference: 'sub_42:2026-11-01',
            amount: '1000',
            expiresAt: paid.periodEnd,
            payment: paid.link,
          }),
        ),
      );

      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.allocation.id)).size).toBe(1);
      expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
      await expect(
        client.creditAllocation.count({ where: { authId: userId } }),
      ).resolves.toBe(1);
      await expect(
        client.creditTransaction.count({ where: { authId: userId } }),
      ).resolves.toBe(1);
      await expect(wallet.getBalance(userId)).resolves.toMatchObject({
        available: '1000',
      });
      await expectConsistentLedger(userId);
    });

    it('grants trial credits once even when different trial grants race', async () => {
      const userId = await createUser(client);
      const expiresAt = new Date(Date.now() + 7 * DAY);
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          wallet.grant({
            authId: userId,
            source: CreditSource.TRIAL,
            sourceReference: `trial-${i}`,
            amount: 50,
            expiresAt,
          }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(CreditConflictError);
        }
      }
      await expect(wallet.getBalance(userId)).resolves.toMatchObject({
        available: '50',
      });
    });

    it('never overdraws the balance under concurrent debits', async () => {
      const userId = await createUser(client);
      await grantPurchase(userId, '10');

      const results = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) =>
          wallet.debit({
            authId: userId,
            amount: '0.5',
            idempotencyKey: `run-${i}`,
          }),
        ),
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(succeeded).toHaveLength(20);
      expect(rejected).toHaveLength(10);
      for (const result of rejected) {
        expect(result.reason).toBeInstanceOf(InsufficientCreditsError);
        expect(result.reason).toMatchObject({
          status: 403,
          message: 'Insufficient credits',
        });
      }
      await expect(wallet.getBalance(userId)).resolves.toMatchObject({
        available: '0',
      });
      const { transactions } = await expectConsistentLedger(userId);
      expect(transactions).toHaveLength(21);
    });

    it('applies a debit once when the same idempotency key is retried concurrently', async () => {
      const userId = await createUser(client);
      await grantPurchase(userId, '5');

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          wallet.debit({
            authId: userId,
            amount: '1.25',
            idempotencyKey: 'ai-run-7',
          }),
        ),
      );

      expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      await expect(wallet.getBalance(userId)).resolves.toMatchObject({
        available: '3.75',
      });
      await expectConsistentLedger(userId);
    });

    it('caps concurrent session overage at the configured allowance', async () => {
      const userId = await createUser(client);
      const session = await client.makeupSession.create({
        data: { authId: userId },
      });
      await grantPurchase(userId, '0.5');
      // Initialized with the 0.5 credits, which fixes its overage limit.
      await wallet.initializeSession({ authId: userId, sessionId: session.id });

      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          wallet.debit({
            authId: userId,
            amount: '0.5',
            idempotencyKey: `step-${i}`,
            sessionId: session.id,
          }),
        ),
      );

      // 0.5 from the balance, then 10 x 0.5 = 5 overage credits (the default).
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(11);
      await expect(
        client.creditSessionOverage.findMany({ where: { authId: userId } }),
      ).resolves.toEqual([
        expect.objectContaining({
          sessionId: session.id,
          overageLimit: D(5),
          overageUsed: D(5),
        }),
      ]);
      const overage = await client.creditTransaction.aggregate({
        where: { authId: userId, sessionId: session.id },
        _sum: { overageAmount: true },
      });
      expect(overage._sum.overageAmount?.toFixed()).toBe('5');
      await expect(wallet.getBalance(userId)).resolves.toMatchObject({
        available: '0',
      });
      await expectConsistentLedger(userId);
    });

    it('stays consistent when grants, debits and expiration sweeps run together', async () => {
      const userId = await createUser(client);
      const other = await createUser(client);
      const t0 = new Date('2032-05-01T00:00:00.000Z');
      freezeTime(t0);
      await grantPurchase(userId, '3');
      // Expires while the operations below run (the clock is moved past it
      // halfway through), so expirations race with grants and debits.
      const { link } = await paidMonth(userId, t0);
      await wallet.grant({
        authId: userId,
        source: CreditSource.SUBSCRIPTION,
        sourceReference: 'short-lived',
        amount: '4',
        expiresAt: new Date(t0.getTime() + HOUR),
        payment: link,
      });

      const operations: Promise<unknown>[] = [];
      for (let i = 0; i < 15; i += 1) {
        if (i === 7) jest.setSystemTime(new Date(t0.getTime() + 2 * HOUR));
        operations.push(grantPurchase(userId, '0.25', `mix-${i}`));
        operations.push(
          wallet.debit({
            authId: userId,
            amount: '0.4',
            idempotencyKey: `mix-${i}`,
          }),
        );
        operations.push(grantPurchase(other, '1', `other-${i}`));
        operations.push(wallet.expireDueCredits());
      }
      await Promise.allSettled(operations);
      await wallet.expireDueCredits();

      const { transactions } = await expectConsistentLedger(userId);
      // The short-lived subscription credits expired exactly once (unless
      // debits used them all first).
      expect(
        transactions.filter((t) => t.type === 'EXPIRATION').length,
      ).toBeLessThanOrEqual(1);
      await expect(wallet.getBalance(userId)).resolves.toMatchObject({
        bySource: { SUBSCRIPTION: '0' },
      });
      const { remaining } = await expectConsistentLedger(other);
      expect(remaining.toFixed()).toBe('15');
    });
  });

  describe('expiration', () => {
    it('stops counting trial and subscription credits at expiry and records each expiration once', async () => {
      const userId = await createUser(client);
      const t0 = new Date('2030-01-01T10:00:00.000Z');
      freezeTime(t0);
      await wallet.grant({
        authId: userId,
        source: CreditSource.TRIAL,
        sourceReference: 'trial',
        amount: '50',
        expiresAt: new Date(t0.getTime() + 7 * DAY),
      });
      const paid = await paidMonth(userId, t0);
      expect(paid.periodEnd).toEqual(new Date(t0.getTime() + 31 * DAY));
      await wallet.grant({
        authId: userId,
        source: CreditSource.SUBSCRIPTION,
        sourceReference: 'sub:2030-01',
        amount: '1000',
        expiresAt: paid.periodEnd,
        payment: paid.link,
      });
      await wallet.grant({
        authId: userId,
        source: CreditSource.PURCHASE,
        sourceReference: 'pay_1',
        amount: '20',
      });
      await wallet.grant({
        authId: userId,
        source: CreditSource.REFERRAL,
        sourceReference: 'ref_1',
        amount: '5',
      });
      // Trial credits are spent first (they expire soonest).
      await wallet.debit({
        authId: userId,
        amount: '10.5',
        idempotencyKey: 'r1',
      });

      // At the trial's exact expiry: it no longer counts, nothing recorded yet.
      freezeTime(new Date(t0.getTime() + 7 * DAY));
      await expect(wallet.getBalance(userId)).resolves.toMatchObject({
        available: '1025',
        bySource: {
          TRIAL: '0',
          SUBSCRIPTION: '1000',
          PURCHASE: '20',
          REFERRAL: '5',
        },
      });
      await expect(
        client.creditTransaction.count({
          where: { authId: userId, type: 'EXPIRATION' },
        }),
      ).resolves.toBe(0);

      // Concurrent sweeps record the trial's unused 39.5 credits exactly once.
      await Promise.all([
        wallet.expireDueCredits(),
        wallet.expireDueCredits(),
        wallet.expireCredits(userId),
      ]);
      await wallet.expireDueCredits();
      const expirations = await client.creditTransaction.findMany({
        where: { authId: userId, type: 'EXPIRATION' },
      });
      expect(
        expirations.map((t) => [
          t.amount.toFixed(),
          t.balanceAfter.toFixed(),
          t.occurredAt.toISOString(),
        ]),
      ).toEqual([
        ['-39.5', '1025', new Date(t0.getTime() + 7 * DAY).toISOString()],
      ]);

      // Ten years later only purchased and referral credits remain; the
      // subscription's credits expire when the wallet is next used.
      freezeTime(new Date(t0.getTime() + 3650 * DAY));
      await expect(wallet.getBalance(userId)).resolves.toMatchObject({
        available: '25',
        bySource: {
          TRIAL: '0',
          SUBSCRIPTION: '0',
          PURCHASE: '20',
          REFERRAL: '5',
        },
        nextExpiration: null,
      });
      const debit = await wallet.debit({
        authId: userId,
        amount: '21',
        idempotencyKey: 'r2',
      });
      expect(debit).toMatchObject({ consumed: '21' });

      const history = await wallet.listTransactions(userId);
      expect(
        history.reverse().map((t) => [t.type, t.amount, t.balanceAfter]),
      ).toEqual([
        ['GRANT', '50', '50'],
        ['GRANT', '1000', '1050'],
        ['GRANT', '20', '1070'],
        ['GRANT', '5', '1075'],
        ['DEBIT', '-10.5', '1064.5'],
        ['EXPIRATION', '-39.5', '1025'],
        ['EXPIRATION', '-1000', '25'],
        ['DEBIT', '-21', '4'],
      ]);
      await expectConsistentLedger(userId);
    });

    it('records expirations in the history of wallets nobody uses any more (scheduled sweep)', async () => {
      const sweeper = new CreditExpirationSweepService(
        wallet,
        mock<CustomLoggerService>(),
      );
      const t0 = new Date('2033-02-01T00:00:00.000Z');
      freezeTime(t0);
      const trialUser = await createUser(client);
      const proUser = await createUser(client);
      const trialEnds = new Date(t0.getTime() + 7 * DAY);
      const monthEnds = new Date(t0.getTime() + 28 * DAY);
      await wallet.grant({
        authId: trialUser,
        source: CreditSource.TRIAL,
        sourceReference: 'trial',
        amount: '50',
        expiresAt: trialEnds,
      });
      const paid = await paidMonth(proUser, t0);
      expect(paid.periodEnd).toEqual(monthEnds);
      await wallet.grant({
        authId: proUser,
        source: CreditSource.SUBSCRIPTION,
        sourceReference: 'pro:2033-02',
        amount: '1000',
        expiresAt: monthEnds,
        payment: paid.link,
      });
      await wallet.grant({
        authId: proUser,
        source: CreditSource.PURCHASE,
        sourceReference: 'pay_keep',
        amount: '3.5',
      });
      await wallet.debit({
        authId: proUser,
        amount: '0.25',
        idempotencyKey: 'u',
      });
      // From here on, neither wallet is used again.

      freezeTime(new Date(t0.getTime() + 60 * DAY));
      const result = await sweeper.sweep();
      expect(result?.expirations).toBeGreaterThanOrEqual(2);
      // A second sweep finds nothing more for these wallets.
      await sweeper.sweep();

      const expirations = await client.creditTransaction.findMany({
        where: { authId: { in: [trialUser, proUser] }, type: 'EXPIRATION' },
        orderBy: { sequence: 'asc' },
      });
      expect(
        expirations.map((t) => [
          t.authId,
          t.amount.toFixed(),
          t.balanceAfter.toFixed(),
          t.occurredAt.toISOString(),
          t.description,
        ]),
      ).toEqual([
        [
          trialUser,
          '-50',
          '0',
          trialEnds.toISOString(),
          'TRIAL credits expired',
        ],
        [
          proUser,
          '-999.75',
          '3.5',
          monthEnds.toISOString(),
          'SUBSCRIPTION credits expired',
        ],
      ]);
      // Purchased credits never expire; the traced history is consistent.
      await expect(wallet.getBalance(proUser)).resolves.toMatchObject({
        available: '3.5',
      });
      await expectConsistentLedger(trialUser);
      await expectConsistentLedger(proUser);
    });

    it('recognizes a retried grant after its credits have expired', async () => {
      const userId = await createUser(client);
      const t0 = new Date('2031-03-01T00:00:00.000Z');
      freezeTime(t0);
      const grant = () =>
        wallet.grant({
          authId: userId,
          source: CreditSource.TRIAL,
          sourceReference: 'trial',
          amount: 50,
          expiresAt: new Date(t0.getTime() + DAY),
        });
      await grant();
      freezeTime(new Date(t0.getTime() + 2 * DAY));

      await expect(grant()).resolves.toMatchObject({
        replayed: true,
        allocation: { remaining: '0' },
      });
      await expectConsistentLedger(userId);
    });
  });

  describe('reliable history', () => {
    it('refuses to change or delete ledger rows, or to add credits back to an allocation', async () => {
      const userId = await createUser(client);
      await grantPurchase(userId, '10');
      await wallet.debit({ authId: userId, amount: '4', idempotencyKey: 'h1' });
      const [transaction] = await client.creditTransaction.findMany({
        where: { authId: userId },
      });
      const [allocation] = await client.creditAllocation.findMany({
        where: { authId: userId },
      });
      const before = await expectConsistentLedger(userId);

      for (const [statement, message] of [
        [
          `UPDATE "CreditTransaction" SET "amount" = 100 WHERE "id" = '${transaction.id}'`,
          'append-only',
        ],
        [
          `DELETE FROM "CreditTransaction" WHERE "id" = '${transaction.id}'`,
          'cannot be deleted',
        ],
        [
          `UPDATE "CreditLedgerEntry" SET "amount" = 1 WHERE "allocationId" = '${allocation.id}'`,
          'append-only',
        ],
        [
          `DELETE FROM "CreditLedgerEntry" WHERE "allocationId" = '${allocation.id}'`,
          'cannot be deleted',
        ],
        [
          `UPDATE "CreditAllocation" SET "remaining" = 10 WHERE "id" = '${allocation.id}'`,
          'can only decrease',
        ],
        [
          `UPDATE "CreditAllocation" SET "amount" = 99 WHERE "id" = '${allocation.id}'`,
          'cannot change',
        ],
        [
          `UPDATE "CreditAllocation" SET "expiresAt" = now() WHERE "id" = '${allocation.id}'`,
          'cannot change',
        ],
        [
          `DELETE FROM "CreditAllocation" WHERE "id" = '${allocation.id}'`,
          'cannot be deleted',
        ],
        [
          `DELETE FROM "CreditWallet" WHERE "authId" = '${userId}'`,
          'cannot be deleted',
        ],
        // Removing credits without a ledger entry fails at commit.
        [
          `UPDATE "CreditAllocation" SET "remaining" = 1 WHERE "id" = '${allocation.id}'`,
          'does not match its ledger entries',
        ],
      ] as const) {
        await expect(client.$executeRawUnsafe(statement)).rejects.toThrow(
          message,
        );
      }

      const after = await expectConsistentLedger(userId);
      expect(after.remaining.toFixed()).toBe(before.remaining.toFixed());
      expect(after.transactions).toEqual(before.transactions);
    });

    it('refuses a transaction whose balance does not continue the history', async () => {
      const userId = await createUser(client);
      const { allocation } = await grantPurchase(userId, '10');
      const { id: walletId } = await client.creditWallet.findUniqueOrThrow({
        where: { authId: userId },
      });

      await expect(
        client.$transaction(async (tx) => {
          await tx.creditAllocation.update({
            where: { id: allocation.id },
            data: { remaining: 9 },
          });
          await tx.creditTransaction.create({
            data: {
              walletId,
              authId: userId,
              type: 'DEBIT',
              amount: -1,
              balanceAfter: 5, // should be 9
              idempotencyKey: 'forged',
              occurredAt: new Date(),
              entries: {
                create: [{ allocationId: allocation.id, amount: -1 }],
              },
            },
          });
        }),
      ).rejects.toThrow('does not continue the previous balance');
      await expectConsistentLedger(userId);
    });

    it('deletes the wallet and its history together with the user (account erasure)', async () => {
      const userId = await createUser(client);
      const session = await client.makeupSession.create({
        data: { authId: userId },
      });
      await grantPurchase(userId, '1');
      await wallet.initializeSession({ authId: userId, sessionId: session.id });
      await wallet.debit({
        authId: userId,
        amount: '2',
        idempotencyKey: 'x',
        sessionId: session.id,
      });

      await client.authUser.delete({ where: { id: userId } });

      const counts = await Promise.all([
        client.creditWallet.count({ where: { authId: userId } }),
        client.creditAllocation.count({ where: { authId: userId } }),
        client.creditTransaction.count({ where: { authId: userId } }),
        client.creditSessionOverage.count({ where: { authId: userId } }),
      ]);
      expect(counts).toEqual([0, 0, 0, 0]);
    });
  });

  it('fixes the session overage limit from the credit settings when the session is initialized', async () => {
    const admin = await createUser(client);
    const userId = await createUser(client);
    const session = await client.makeupSession.create({
      data: { authId: userId },
    });
    await grantPurchase(userId, '1');
    await settings.updateSettings(
      { sessionOverageCredits: 0 },
      { actionedBy: admin },
    );
    try {
      await wallet.initializeSession({ authId: userId, sessionId: session.id });
    } finally {
      await settings.updateSettings(
        { sessionOverageCredits: 5 },
        { actionedBy: admin },
      );
    }

    // The setting is 5 again, but this session was initialized without overage.
    await expect(
      wallet.debit({
        authId: userId,
        amount: '1.1',
        idempotencyKey: 'no-overage',
        sessionId: session.id,
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    await expect(
      client.creditSessionOverage.findFirstOrThrow({
        where: { authId: userId },
      }),
    ).resolves.toMatchObject({ overageLimit: D(0), overageUsed: D(0) });
    await expect(
      client.creditTransaction.count({ where: { authId: userId } }),
    ).resolves.toBe(1);
  });
});
