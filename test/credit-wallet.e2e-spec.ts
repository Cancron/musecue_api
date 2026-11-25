import { PrismaPg } from '@prisma/adapter-pg';
import { CreditSource, PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { CreditExpirySweepService } from '../src/credit/credit-expiry-sweep.service';
import { CreditSettingsService } from '../src/credit/credit-settings.service';
import { CreditWalletService } from '../src/credit/credit-wallet.service';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import { addBillingInterval } from '../src/subscription/billing.validation';
import {
  createUser,
  givenPaidMonth,
  recordPayment,
} from './support/subscription-fixtures';

jest.setTimeout(120_000);

const INSUFFICIENT = { status: 403, message: 'Insufficient credits' };
const HOUR = 3_600_000;

/**
 * The credit wallet and ledger against a fully migrated PostgreSQL schema:
 * allocations per user and source, expiry, exact fractional amounts, session
 * overage, ledger history, concurrent operations, and the database rules
 * that protect the ledger. Runs only when TEST_DATABASE_URL is set.
 */
describeWithDatabase('AI credit wallet and ledger (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  let settings: CreditSettingsService;
  let wallets: CreditWalletService;

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    client = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: TEST_DATABASE_URL as string,
          // Raw SQL (the wallet row lock) resolves tables via search_path.
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
    wallets = new CreditWalletService(prisma, settings);
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
  });

  const newUser = () => createUser(client);
  const newSession = async (authId: string) =>
    (await client.makeupSession.create({ data: { authId } })).id;
  const inHours = (hours: number, from = new Date()) =>
    new Date(from.getTime() + hours * HOUR);

  const allocate = (
    authId: string,
    source: CreditSource,
    credits: string | number,
    options: { ref?: string; expiresAt?: Date | null; now?: Date } = {},
  ) =>
    wallets.allocate({
      authId,
      source,
      credits,
      sourceReference: options.ref ?? `${source}:${authId}:${Math.random()}`,
      expiresAt:
        options.expiresAt !== undefined
          ? options.expiresAt
          : source === CreditSource.TRIAL ||
              source === CreditSource.SUBSCRIPTION
            ? inHours(24 * 30, options.now)
            : null,
      now: options.now,
    });

  /** Monthly Pro credits for a real, SUCCEEDED payment of `periodStart`'s month. */
  const allocatePaidMonth = async (
    authId: string,
    credits: number | string,
    periodStart: Date,
    now?: Date,
  ) => {
    const paid = await givenPaidMonth(client, authId, periodStart);
    const result = await wallets.allocateSubscriptionCredits({
      authId,
      ...paid,
      credits,
      now,
    });
    return { ...paid, ...result };
  };

  const available = async (authId: string, now?: Date) =>
    (await wallets.getBalance(authId, now)).availableCredits;

  /**
   * Independent reconciliation of one wallet with plain SQL: the stored
   * balance and overage equal the allocations, the session overage and the
   * ledger's running totals; every transaction and allocation equals the sum
   * of its entries; sequences are 1..n.
   */
  const reconcile = async (authId: string) => {
    const [wallet] = await client.$queryRaw<
      {
        id: string;
        balance: string;
        overage: string;
        allocated: string;
        unsettled: string;
        ledger_balance: string | null;
        ledger_overage: string | null;
        tx_count: number;
        max_sequence: number | null;
      }[]
    >`
      SELECT w."id",
             w."balanceCredits"::text AS balance,
             w."outstandingOverageCredits"::text AS overage,
             (SELECT COALESCE(SUM("remainingCredits"), 0)::numeric(20,6)::text FROM "CreditAllocation" WHERE "walletId" = w."id") AS allocated,
             (SELECT COALESCE(SUM("overageCredits" - "settledCredits"), 0)::numeric(20,6)::text FROM "CreditSessionOverage" WHERE "walletId" = w."id") AS unsettled,
             (SELECT COALESCE(SUM("amountCredits"), 0)::numeric(20,6)::text FROM "CreditTransaction" WHERE "walletId" = w."id") AS ledger_balance,
             (SELECT COALESCE(SUM("overageChangeCredits"), 0)::numeric(20,6)::text FROM "CreditTransaction" WHERE "walletId" = w."id") AS ledger_overage,
             (SELECT COUNT(*)::int FROM "CreditTransaction" WHERE "walletId" = w."id") AS tx_count,
             (SELECT MAX("sequence") FROM "CreditTransaction" WHERE "walletId" = w."id") AS max_sequence
      FROM "CreditWallet" w WHERE w."authId" = ${authId}`;
    expect(wallet).toBeDefined();
    expect(wallet.allocated).toBe(wallet.balance);
    expect(wallet.ledger_balance).toBe(wallet.balance);
    expect(wallet.unsettled).toBe(wallet.overage);
    expect(wallet.ledger_overage).toBe(wallet.overage);
    expect(wallet.max_sequence ?? 0).toBe(wallet.tx_count);

    const mismatched = await client.$queryRaw<{ id: string }[]>`
      SELECT t."id" FROM "CreditTransaction" t
      WHERE t."walletId" = ${wallet.id}
        AND t."amountCredits" <> COALESCE((SELECT SUM(e."amountCredits") FROM "CreditTransactionEntry" e WHERE e."transactionId" = t."id"), 0)
      UNION ALL
      SELECT a."id" FROM "CreditAllocation" a
      WHERE a."walletId" = ${wallet.id}
        AND a."remainingCredits" <> COALESCE((SELECT SUM(e."amountCredits") FROM "CreditTransactionEntry" e WHERE e."allocationId" = a."id"), 0)`;
    expect(mismatched).toEqual([]);
    return wallet;
  };

  describe('allocations', () => {
    it('stores each allocation for the right user and source, with expiry only for trial and subscription credits', async () => {
      const alice = await newUser();
      const bob = await newUser();
      const trialEnd = inHours(24 * 7);

      await allocate(alice, CreditSource.TRIAL, 50, {
        ref: `trial:${alice}`,
        expiresAt: trialEnd,
      });
      const paid = await allocatePaidMonth(alice, 1000, inHours(-1));
      const periodEnd = paid.periodEnd;
      await allocate(alice, CreditSource.PURCHASE, '250.5', {
        ref: `payment:${alice}`,
      });
      await allocate(bob, CreditSource.REFERRAL, 10, {
        ref: `referral:${bob}`,
      });

      const rows = await client.$queryRaw<
        {
          authId: string;
          source: string;
          sourceReference: string;
          granted: string;
          remaining: string;
          expiresAt: Date | null;
        }[]
      >`
        SELECT w."authId", a."source"::text AS source, a."sourceReference",
               a."grantedCredits"::text AS granted, a."remainingCredits"::text AS remaining,
               a."expiresAt"
        FROM "CreditAllocation" a JOIN "CreditWallet" w ON w."id" = a."walletId"
        WHERE w."authId" IN (${alice}, ${bob})
        ORDER BY a."grantedAt", a."source"`;
      expect(rows).toEqual([
        {
          authId: alice,
          source: 'TRIAL',
          sourceReference: `trial:${alice}`,
          granted: '50.000000',
          remaining: '50.000000',
          expiresAt: trialEnd,
        },
        {
          authId: alice,
          source: 'SUBSCRIPTION',
          sourceReference: `pro:${paid.paymentId}`,
          granted: '1000.000000',
          remaining: '1000.000000',
          expiresAt: periodEnd,
        },
        {
          authId: alice,
          source: 'PURCHASE',
          sourceReference: `payment:${alice}`,
          granted: '250.500000',
          remaining: '250.500000',
          expiresAt: null,
        },
        {
          authId: bob,
          source: 'REFERRAL',
          sourceReference: `referral:${bob}`,
          granted: '10.000000',
          remaining: '10.000000',
          expiresAt: null,
        },
      ]);

      await expect(wallets.getBalance(alice)).resolves.toEqual({
        availableCredits: '1300.5',
        availableBySource: {
          TRIAL: '50',
          SUBSCRIPTION: '1000',
          PURCHASE: '250.5',
          REFERRAL: '0',
        },
        outstandingOverageCredits: '0',
        nextExpiration: { expiresAt: trialEnd.toISOString(), credits: '50' },
      });
      await expect(available(bob)).resolves.toBe('10');
      await reconcile(alice);
      await reconcile(bob);
    });

    it('treats a repeated allocation as a no-op and refuses the same source event for another user', async () => {
      const alice = await newUser();
      const bob = await newUser();
      const ref = `payment:${alice}:repeat`;

      const first = await allocate(alice, CreditSource.PURCHASE, 20, { ref });
      const again = await allocate(alice, CreditSource.PURCHASE, 20, { ref });
      expect(first.created).toBe(true);
      expect(again).toEqual({ created: false, allocation: first.allocation });

      await expect(
        allocate(bob, CreditSource.PURCHASE, 20, { ref }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        allocate(alice, CreditSource.PURCHASE, 25, { ref }),
      ).rejects.toMatchObject({ status: 409 });

      await expect(available(alice)).resolves.toBe('20');
      await expect(wallets.getBalance(bob)).resolves.toMatchObject({
        availableCredits: '0',
      });
      await expect(
        client.creditAllocation.count({
          where: { source: CreditSource.PURCHASE, sourceReference: ref },
        }),
      ).resolves.toBe(1);
    });

    it('allows one trial allocation per user', async () => {
      const alice = await newUser();
      await allocate(alice, CreditSource.TRIAL, 50, {
        ref: `trial-a:${alice}`,
      });

      await expect(
        allocate(alice, CreditSource.TRIAL, 50, { ref: `trial-b:${alice}` }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(available(alice)).resolves.toBe('50');
    });

    it('rejects allocations for unknown users and invalid expiry before writing anything', async () => {
      const alice = await newUser();
      await expect(
        allocate('missing-user', CreditSource.PURCHASE, 5),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        allocate(alice, CreditSource.PURCHASE, 5, { expiresAt: inHours(1) }),
      ).rejects.toMatchObject({ status: 400 });
      // Subscription credits only come from a paid period.
      await expect(
        allocate(alice, CreditSource.SUBSCRIPTION, 5, { expiresAt: null }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        client.creditWallet.count({ where: { authId: alice } }),
      ).resolves.toBe(0);
    });
  });

  describe('fractional amounts', () => {
    it('keeps balances and transactions exact to six decimal places', async () => {
      const alice = await newUser();
      await allocate(alice, CreditSource.PURCHASE, '10.5');
      await allocate(alice, CreditSource.REFERRAL, '0.25');
      for (const key of ['a', 'b', 'c']) {
        await wallets.deduct({
          authId: alice,
          credits: '0.1',
          idempotencyKey: `run-${key}`,
        });
      }
      await wallets.deduct({
        authId: alice,
        credits: 0.000001,
        idempotencyKey: 'run-tiny',
      });

      await expect(available(alice)).resolves.toBe('10.449999');
      const wallet = await reconcile(alice);
      expect(wallet.balance).toBe('10.449999');

      const amounts = await client.$queryRaw<{ amount: string }[]>`
        SELECT t."amountCredits"::text AS amount FROM "CreditTransaction" t
        WHERE t."walletId" = ${wallet.id} ORDER BY t."sequence"`;
      expect(amounts.map((row) => row.amount)).toEqual([
        '10.500000',
        '0.250000',
        '-0.100000',
        '-0.100000',
        '-0.100000',
        '-0.000001',
      ]);
    });

    it('rejects amounts that would need rounding instead of rounding them', async () => {
      const alice = await newUser();
      await allocate(alice, CreditSource.PURCHASE, 1);
      await expect(
        wallets.deduct({
          authId: alice,
          credits: '0.0000001',
          idempotencyKey: 'too-precise',
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(available(alice)).resolves.toBe('1');
    });
  });

  describe('expiration', () => {
    it('never counts expired trial or subscription credits, while purchased and referral credits never expire', async () => {
      const alice = await newUser();
      const t0 = new Date();
      await allocate(alice, CreditSource.TRIAL, 50, {
        expiresAt: inHours(1, t0),
        now: t0,
      });
      // A paid month that started 20 days ago (ends 8-11 days from now).
      const paid = await allocatePaidMonth(
        alice,
        1000,
        inHours(-20 * 24, t0),
        t0,
      );
      await allocate(alice, CreditSource.PURCHASE, 30, { now: t0 });
      await allocate(alice, CreditSource.REFERRAL, 5, { now: t0 });

      // Before any expiry transaction is written, reads exclude expired credits.
      await expect(wallets.getBalance(alice, inHours(1, t0))).resolves.toEqual({
        availableCredits: '1035',
        availableBySource: {
          TRIAL: '0',
          SUBSCRIPTION: '1000',
          PURCHASE: '30',
          REFERRAL: '5',
        },
        outstandingOverageCredits: '0',
        nextExpiration: {
          expiresAt: paid.periodEnd.toISOString(),
          credits: '1000',
        },
      });
      // Ten years later only purchased and referral credits remain.
      await expect(
        wallets.getBalance(alice, inHours(24 * 3650, t0)),
      ).resolves.toMatchObject({
        availableCredits: '35',
        nextExpiration: null,
      });
    });

    it('records an EXPIRATION transaction at the expiry time and never spends expired credits', async () => {
      const alice = await newUser();
      const t0 = new Date();
      const trial = await allocate(alice, CreditSource.TRIAL, '12.5', {
        expiresAt: inHours(1, t0),
        now: t0,
      });
      await wallets.deduct({
        authId: alice,
        credits: '2.5',
        idempotencyKey: 'before-expiry',
        now: inHours(0.5, t0),
      });

      const afterExpiry = inHours(3, t0);
      await expect(
        wallets.deduct({
          authId: alice,
          credits: '1',
          idempotencyKey: 'after-expiry',
          now: afterExpiry,
        }),
      ).rejects.toMatchObject(INSUFFICIENT);

      // The refused deduction rolled back; the expiry is written by the next
      // successful operation (here the sweep), dated at the expiry time.
      await expect(wallets.expireDueCredits(alice, afterExpiry)).resolves.toBe(
        1,
      );
      await expect(wallets.expireDueCredits(alice, afterExpiry)).resolves.toBe(
        0,
      );

      const history = await wallets.listTransactions(alice);
      expect(
        history.map((t) => [
          t.sequence,
          t.type,
          t.amountCredits,
          t.balanceAfterCredits,
        ]),
      ).toEqual([
        [3, 'EXPIRATION', '-10', '0'],
        [2, 'DEDUCTION', '-2.5', '10'],
        [1, 'ALLOCATION', '12.5', '12.5'],
      ]);
      expect(history[0]).toMatchObject({
        allocationId: trial.allocation.id,
        effectiveAt: inHours(1, t0).toISOString(),
      });
      const [stored] = await wallets.listAllocations(alice);
      expect(stored).toMatchObject({
        remainingCredits: '0',
        expiredAt: afterExpiry.toISOString(),
      });
      await reconcile(alice);
    });

    it('expires due credits across wallets with the sweep, once', async () => {
      const t0 = new Date();
      const users = [await newUser(), await newUser(), await newUser()];
      for (const user of users) {
        await allocate(user, CreditSource.TRIAL, 100, {
          expiresAt: inHours(1, t0),
          now: t0,
        });
        await allocate(user, CreditSource.PURCHASE, 7, { now: t0 });
      }

      const later = inHours(2, t0);
      let expired = 0;
      for (;;) {
        const result = await wallets.expireAllDueCredits({ now: later });
        if (result.wallets === 0) break;
        expired += result.expiredAllocations;
      }
      expect(expired).toBeGreaterThanOrEqual(users.length);

      for (const user of users) {
        const wallet = await reconcile(user);
        expect(wallet.balance).toBe('7.000000');
        await expect(
          client.creditTransaction.count({
            where: { walletId: wallet.id, type: 'EXPIRATION' },
          }),
        ).resolves.toBe(1);
      }
    });
  });

  describe('session overage', () => {
    it('lets a session go up to the configured overage beyond the balance, and repays it from the next allocation', async () => {
      const alice = await newUser();
      const session = await newSession(alice);
      await allocate(alice, CreditSource.PURCHASE, 2);

      const charged = await wallets.deduct({
        authId: alice,
        credits: '6.5',
        idempotencyKey: 'run-1',
        sessionId: session,
        reference: 'ai-run-1',
      });
      expect(charged.transaction).toMatchObject({
        type: 'DEDUCTION',
        amountCredits: '-2',
        overageChangeCredits: '4.5',
        balanceAfterCredits: '0',
        outstandingOverageAfterCredits: '4.5',
        sessionId: session,
        reference: 'ai-run-1',
      });

      // The default allowance is 5 per session: 0.5 left, 0.500001 is refused.
      await expect(
        wallets.deduct({
          authId: alice,
          credits: '0.500001',
          idempotencyKey: 'run-2',
          sessionId: session,
        }),
      ).rejects.toMatchObject(INSUFFICIENT);
      // Without a session there is no overage at all.
      await expect(
        wallets.deduct({
          authId: alice,
          credits: '0.1',
          idempotencyKey: 'run-3',
        }),
      ).rejects.toMatchObject(INSUFFICIENT);

      const [row] = await client.$queryRaw<
        { limit: string; overage: string; settled: string }[]
      >`
        SELECT "limitCredits"::text AS limit, "overageCredits"::text AS overage, "settledCredits"::text AS settled
        FROM "CreditSessionOverage" WHERE "sessionId" = ${session}`;
      expect(row).toEqual({
        limit: '5.000000',
        overage: '4.500000',
        settled: '0.000000',
      });
      await expect(wallets.getBalance(alice)).resolves.toMatchObject({
        availableCredits: '0',
        outstandingOverageCredits: '4.5',
      });
      await reconcile(alice);

      // The next allocation repays the overage first.
      const topUp = await allocate(alice, CreditSource.PURCHASE, 10);
      expect(topUp.allocation.remainingCredits).toBe('5.5');
      await expect(wallets.getBalance(alice)).resolves.toMatchObject({
        availableCredits: '5.5',
        outstandingOverageCredits: '0',
      });
      const [latest] = await wallets.listTransactions(alice, { take: 1 });
      expect(latest).toMatchObject({
        type: 'OVERAGE_SETTLEMENT',
        amountCredits: '-4.5',
        overageChangeCredits: '-4.5',
        allocationId: topUp.allocation.id,
      });
      await reconcile(alice);
    });

    it('fixes a session limit when it first uses overage; later settings changes apply to new sessions', async () => {
      const admin = await newUser();
      const alice = await newUser();
      const first = await newSession(alice);
      const second = await newSession(alice);

      await wallets.deduct({
        authId: alice,
        credits: 1,
        idempotencyKey: 'first-1',
        sessionId: first,
      });
      await settings.updateSettings(
        { sessionOverageAllowanceCredits: 2 },
        { actionedBy: admin },
      );

      // The first session keeps its limit of 5 (4 left)...
      await wallets.deduct({
        authId: alice,
        credits: 4,
        idempotencyKey: 'first-2',
        sessionId: first,
      });
      // ...the second session gets the new limit of 2.
      await expect(
        wallets.deduct({
          authId: alice,
          credits: '2.000001',
          idempotencyKey: 'second-1',
          sessionId: second,
        }),
      ).rejects.toMatchObject(INSUFFICIENT);
      await wallets.deduct({
        authId: alice,
        credits: 2,
        idempotencyKey: 'second-2',
        sessionId: second,
      });

      await expect(wallets.getBalance(alice)).resolves.toMatchObject({
        outstandingOverageCredits: '7',
      });
      await reconcile(alice);
      await settings.updateSettings(
        { sessionOverageAllowanceCredits: 5 },
        { actionedBy: admin },
      );
    });

    it('refuses to charge another user’s session', async () => {
      const alice = await newUser();
      const bob = await newUser();
      const bobsSession = await newSession(bob);
      await allocate(alice, CreditSource.PURCHASE, 10);

      await expect(
        wallets.deduct({
          authId: alice,
          credits: 1,
          idempotencyKey: 'wrong-session',
          sessionId: bobsSession,
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(available(alice)).resolves.toBe('10');
    });
  });

  describe('ledger history', () => {
    it('keeps a numbered history of additions, deductions, expirations and settlements with running totals', async () => {
      const alice = await newUser();
      const session = await newSession(alice);
      const t0 = new Date();
      await allocate(alice, CreditSource.TRIAL, 3, {
        expiresAt: inHours(1, t0),
        now: t0,
      });
      await allocate(alice, CreditSource.PURCHASE, 2, { now: t0 });
      await wallets.deduct({
        authId: alice,
        credits: '1.5',
        idempotencyKey: 'spend-1',
        now: inHours(0.5, t0),
      });
      await wallets.deduct({
        authId: alice,
        credits: 3,
        idempotencyKey: 'spend-2',
        sessionId: session,
        now: inHours(2, t0),
      });
      await allocate(alice, CreditSource.REFERRAL, 4, { now: inHours(3, t0) });

      const history = (await wallets.listTransactions(alice)).reverse();
      expect(
        history.map((t) => [
          t.sequence,
          t.type,
          t.amountCredits,
          t.overageChangeCredits,
          t.balanceAfterCredits,
          t.outstandingOverageAfterCredits,
        ]),
      ).toEqual([
        [1, 'ALLOCATION', '3', '0', '3', '0'],
        [2, 'ALLOCATION', '2', '0', '5', '0'],
        // The trial (expiring soonest) is spent first.
        [3, 'DEDUCTION', '-1.5', '0', '3.5', '0'],
        // The next operation after the trial's expiry records it...
        [4, 'EXPIRATION', '-1.5', '0', '2', '0'],
        // ...and the purchase plus 1 credit of overage pay for the run.
        [5, 'DEDUCTION', '-2', '1', '0', '1'],
        [6, 'ALLOCATION', '4', '0', '4', '1'],
        [7, 'OVERAGE_SETTLEMENT', '-1', '-1', '3', '0'],
      ]);
      expect(history[2].entries).toEqual([
        {
          allocationId: history[0].allocationId,
          amountCredits: '-1.5',
        },
      ]);
      await reconcile(alice);
    });

    it('makes deductions idempotent and refuses reusing a key for another amount', async () => {
      const alice = await newUser();
      await allocate(alice, CreditSource.PURCHASE, 10);

      const first = await wallets.deduct({
        authId: alice,
        credits: 3,
        idempotencyKey: 'ai-run-42',
      });
      const retry = await wallets.deduct({
        authId: alice,
        credits: 3,
        idempotencyKey: 'ai-run-42',
      });
      expect(retry).toEqual({
        duplicate: true,
        transaction: first.transaction,
      });
      await expect(
        wallets.deduct({
          authId: alice,
          credits: 4,
          idempotencyKey: 'ai-run-42',
        }),
      ).rejects.toMatchObject({ status: 409 });

      await expect(available(alice)).resolves.toBe('7');
    });
  });

  describe('concurrent operations', () => {
    it('creates one allocation when the same payment is allocated concurrently', async () => {
      const alice = await newUser();
      const paid = await givenPaidMonth(client, alice, inHours(-1));

      const results = await Promise.all(
        Array.from({ length: 25 }, () =>
          wallets.allocateSubscriptionCredits({
            authId: alice,
            ...paid,
            credits: 1000,
          }),
        ),
      );

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.allocation.id)).size).toBe(1);
      await expect(available(alice)).resolves.toBe('1000');
      await expect(
        client.creditWallet.count({ where: { authId: alice } }),
      ).resolves.toBe(1);
      const wallet = await reconcile(alice);
      expect(wallet.tx_count).toBe(1);
    });

    it('grants at most one trial under concurrent trial allocations', async () => {
      const alice = await newUser();
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          allocate(alice, CreditSource.TRIAL, 50, {
            ref: `trial:${alice}:${i}`,
          }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason).toMatchObject({ status: 409 });
        }
      }
      await expect(available(alice)).resolves.toBe('50');
      await reconcile(alice);
    });

    it('gives one source event to exactly one of two users racing for it', async () => {
      const alice = await newUser();
      const bob = await newUser();
      const ref = `payment:race:${alice}`;

      const results = await Promise.allSettled([
        ...Array.from({ length: 5 }, () =>
          allocate(alice, CreditSource.PURCHASE, 40, { ref }),
        ),
        ...Array.from({ length: 5 }, () =>
          allocate(bob, CreditSource.PURCHASE, 40, { ref }),
        ),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled').length).toBe(5);
      const balances = [await available(alice), await available(bob)].sort();
      expect(balances).toEqual(['0', '40']);
      await expect(
        client.creditAllocation.count({ where: { sourceReference: ref } }),
      ).resolves.toBe(1);
    });

    it('never overspends under concurrent fractional deductions', async () => {
      const alice = await newUser();
      await allocate(alice, CreditSource.PURCHASE, 5);

      const results = await Promise.allSettled(
        Array.from({ length: 40 }, (_, i) =>
          wallets.deduct({
            authId: alice,
            credits: '0.333333',
            idempotencyKey: `parallel-${i}`,
          }),
        ),
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      expect(succeeded).toHaveLength(15); // 15 x 0.333333 = 4.999995 <= 5
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason).toMatchObject(INSUFFICIENT);
        }
      }
      await expect(available(alice)).resolves.toBe('0.000005');
      const wallet = await reconcile(alice);
      expect(wallet.tx_count).toBe(16);
    });

    it('applies a deduction once when the same request is retried concurrently', async () => {
      const alice = await newUser();
      await allocate(alice, CreditSource.PURCHASE, 10);

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          wallets.deduct({
            authId: alice,
            credits: '1.75',
            idempotencyKey: 'same-run',
          }),
        ),
      );

      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
      await expect(available(alice)).resolves.toBe('8.25');
      await reconcile(alice);
    });

    it('keeps the books balanced under a mix of concurrent allocations, deductions, overage and expiry', async () => {
      const alice = await newUser();
      const session = await newSession(alice);
      const t0 = new Date();
      await allocate(alice, CreditSource.TRIAL, 3, {
        expiresAt: inHours(1, t0),
        now: t0,
      });

      const later = inHours(2, t0);
      await Promise.allSettled([
        ...Array.from({ length: 8 }, (_, i) =>
          allocate(alice, CreditSource.PURCHASE, '1.1', {
            ref: `mix:${alice}:${i}`,
            now: later,
          }),
        ),
        ...Array.from({ length: 12 }, (_, i) =>
          wallets.deduct({
            authId: alice,
            credits: '0.9',
            idempotencyKey: `mix-${i}`,
            sessionId: i % 2 === 0 ? session : undefined,
            now: later,
          }),
        ),
        wallets.expireAllDueCredits({ now: later }),
      ]);

      const wallet = await reconcile(alice);
      const overage = Number(wallet.overage);
      expect(overage).toBeLessThanOrEqual(5);
      expect(overage === 0 || Number(wallet.balance) === 0).toBe(true);
      await expect(wallets.getBalance(alice, later)).resolves.toMatchObject({
        availableBySource: { TRIAL: '0' },
      });
    });
  });

  describe('expiry of idle wallets (scheduled sweep)', () => {
    it('records an EXPIRATION at the expiry time for wallets nobody touches, exactly once', async () => {
      const sweeper = new CreditExpirySweepService(
        wallets,
        mock<CustomLoggerService>(),
      );
      const t0 = new Date(Date.now() - 48 * HOUR);
      const idle = [await newUser(), await newUser()];
      for (const [i, user] of idle.entries()) {
        await allocate(user, CreditSource.TRIAL, 50, {
          expiresAt: inHours(1 + i, t0),
          now: t0,
        });
        await allocate(user, CreditSource.REFERRAL, 5, { now: t0 });
      }
      const active = await newUser();
      await allocate(active, CreditSource.TRIAL, 10, {
        expiresAt: inHours(24),
      });

      const result = await sweeper.sweep();
      expect(result?.expiredAllocations).toBeGreaterThanOrEqual(2);
      await expect(sweeper.sweep()).resolves.toMatchObject({
        expiredAllocations: 0,
      });

      for (const [i, user] of idle.entries()) {
        const [expiration] = await wallets.listTransactions(user, { take: 1 });
        expect(expiration).toMatchObject({
          type: 'EXPIRATION',
          amountCredits: '-50',
          balanceAfterCredits: '5',
          effectiveAt: inHours(1 + i, t0).toISOString(),
        });
        const wallet = await reconcile(user);
        expect(wallet.balance).toBe('5.000000');
      }
      // Unexpired credits are untouched.
      await expect(wallets.listTransactions(active)).resolves.toHaveLength(1);
    });
  });

  describe('manual grants in PostgreSQL ("Credit_grant_manual")', () => {
    const grant = (
      authId: string,
      source: string,
      reference: string,
      credits: string,
    ) =>
      client.$queryRaw<{ id: string }[]>`
        SELECT "Credit_grant_manual"(${authId}, ${source}::"CreditSource", ${reference}, ${credits}::numeric) AS id`;

    it('writes a consistent, traceable allocation of non-expiring credits', async () => {
      const alice = await newUser();
      const [{ id }] = await grant(alice, 'PURCHASE', 'ticket-1', '12.5');

      const [allocation] = await wallets.listAllocations(alice);
      expect(allocation).toMatchObject({
        id,
        source: 'PURCHASE',
        sourceReference: 'ticket-1',
        grantedCredits: '12.5',
        remainingCredits: '12.5',
        expiresAt: null,
      });
      const [transaction] = await wallets.listTransactions(alice);
      expect(transaction).toMatchObject({
        sequence: 1,
        type: 'ALLOCATION',
        amountCredits: '12.5',
        balanceAfterCredits: '12.5',
        allocationId: id,
        reference: 'manual-grant',
      });
      // Timestamps are stored in UTC like the application's.
      expect(
        Math.abs(new Date(allocation.grantedAt).getTime() - Date.now()),
      ).toBeLessThan(60_000);
      await reconcile(alice);
    });

    it('adds to a wallet with history and is idempotent for the same grant', async () => {
      const alice = await newUser();
      await allocate(alice, CreditSource.PURCHASE, 2);
      await wallets.deduct({ authId: alice, credits: 1, idempotencyKey: 'a' });

      const [first] = await grant(alice, 'REFERRAL', 'referral-7', '3');
      const [again] = await grant(alice, 'REFERRAL', ' referral-7 ', '3');

      expect(again.id).toBe(first.id);
      await expect(available(alice)).resolves.toBe('4');
      const wallet = await reconcile(alice);
      expect(wallet.tx_count).toBe(3);
    });

    it.each([
      ['a trial grant', 'TRIAL', 'x', '5'],
      ['a subscription grant', 'SUBSCRIPTION', 'x', '5'],
      ['zero credits', 'PURCHASE', 'x', '0'],
      ['negative credits', 'PURCHASE', 'x', '-1'],
      ['more than 6 decimal places', 'PURCHASE', 'x', '0.0000001'],
      ['an empty reference', 'PURCHASE', '  ', '5'],
    ])('rejects %s', async (_case, source, reference, credits) => {
      const alice = await newUser();
      await expect(grant(alice, source, reference, credits)).rejects.toThrow();
      await expect(available(alice)).resolves.toBe('0');
    });

    it('rejects unknown users, reusing a grant for another user or amount, and wallets with unpaid overage', async () => {
      const alice = await newUser();
      const bob = await newUser();
      await expect(grant('missing', 'PURCHASE', 'x', '1')).rejects.toThrow(
        /does not exist/,
      );
      await grant(alice, 'PURCHASE', 'shared-ref', '5');
      await expect(grant(bob, 'PURCHASE', 'shared-ref', '5')).rejects.toThrow(
        /already granted/,
      );
      await expect(grant(alice, 'PURCHASE', 'shared-ref', '6')).rejects.toThrow(
        /already granted/,
      );

      const session = await newSession(bob);
      await wallets.deduct({
        authId: bob,
        credits: 2,
        idempotencyKey: 'overage',
        sessionId: session,
      });
      await expect(
        grant(bob, 'PURCHASE', 'after-overage', '5'),
      ).rejects.toThrow(/unpaid session overage/);
      await expect(available(alice)).resolves.toBe('5');
      await reconcile(bob);
    });
  });

  describe('database protection', () => {
    /** Runs raw SQL in its own transaction, so deferred checks run at commit. */
    const rawTransaction = (sql: string) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(sql);
      });

    let ownerId: string;
    let walletId: string;
    let allocationId: string;
    beforeAll(async () => {
      const alice = await newUser();
      ownerId = alice;
      const result = await allocate(alice, CreditSource.PURCHASE, 10);
      await wallets.deduct({ authId: alice, credits: 1, idempotencyKey: 'x' });
      allocationId = result.allocation.id;
      walletId = (
        await client.creditWallet.findUniqueOrThrow({
          where: { authId: alice },
        })
      ).id;
    });

    it.each([
      [
        'rewriting a ledger transaction',
        `UPDATE "CreditTransaction" SET "amountCredits" = 100 WHERE "walletId" = '%W'`,
      ],
      [
        'deleting a ledger transaction',
        `DELETE FROM "CreditTransaction" WHERE "walletId" = '%W'`,
      ],
      [
        'rewriting a ledger entry',
        `UPDATE "CreditTransactionEntry" SET "amountCredits" = 100 WHERE "walletId" = '%W'`,
      ],
      [
        'changing a balance without the ledger',
        `UPDATE "CreditWallet" SET "balanceCredits" = 1000 WHERE "id" = '%W'`,
      ],
      [
        'increasing remaining credits',
        `UPDATE "CreditAllocation" SET "remainingCredits" = 10 WHERE "id" = '%A'`,
      ],
      [
        'changing an allocation amount',
        `UPDATE "CreditAllocation" SET "grantedCredits" = 99 WHERE "id" = '%A'`,
      ],
      [
        'giving purchased credits an expiry',
        `UPDATE "CreditAllocation" SET "expiresAt" = now() + interval '1 day' WHERE "id" = '%A'`,
      ],
      [
        'deleting an allocation',
        `DELETE FROM "CreditAllocation" WHERE "id" = '%A'`,
      ],
      [
        'deleting a wallet of an existing user',
        `DELETE FROM "CreditWallet" WHERE "id" = '%W'`,
      ],
      [
        'a negative balance',
        `UPDATE "CreditWallet" SET "balanceCredits" = -1 WHERE "id" = '%W'`,
      ],
      [
        'inserting credits without a ledger transaction',
        `INSERT INTO "CreditAllocation" ("id", "walletId", "source", "sourceReference", "grantedCredits", "remainingCredits", "updatedAt")
         VALUES ('forged', '%W', 'PURCHASE', 'forged', 5, 5, now())`,
      ],
      [
        'a non-expiring trial allocation',
        `INSERT INTO "CreditAllocation" ("id", "walletId", "source", "sourceReference", "grantedCredits", "remainingCredits", "updatedAt")
         VALUES ('forged-trial', '%W', 'TRIAL', 'forged-trial', 5, 5, now())`,
      ],
    ])('rejects %s', async (_case, sql) => {
      const before = await reconcile(ownerId);
      await expect(
        rawTransaction(
          sql.replace(/%W/g, walletId).replace(/%A/g, allocationId),
        ),
      ).rejects.toThrow();
      const after = await reconcile(ownerId);
      expect(after).toEqual(before);
    });

    it("PostgreSQL refuses subscription credits that do not match a succeeded payment of the user's subscription period", async () => {
      const alice = await newUser();
      const bob = await newUser();
      const periodStart = inHours(-1);
      const paid = await givenPaidMonth(client, alice, periodStart);
      const bobs = await givenPaidMonth(client, bob, inHours(-2));
      const failed = await recordPayment(client, paid.subscriptionId, {
        status: 'FAILED',
        billingInterval: 'MONTHLY',
        periodStart: inHours(-3 * 24),
        periodEnd: addBillingInterval(inHours(-3 * 24), 'MONTHLY'),
      });
      const attempt = (
        overrides: Partial<
          Parameters<typeof wallets.allocateSubscriptionCredits>[0]
        >,
      ) =>
        wallets.allocateSubscriptionCredits({
          authId: alice,
          ...paid,
          credits: 1000,
          ...overrides,
        });

      await expect(
        attempt({
          paymentId: failed.id,
          periodStart: failed.periodStart,
          periodEnd: failed.periodEnd,
        }),
      ).rejects.toThrow(/require a succeeded payment/);
      await expect(
        attempt({ subscriptionId: bobs.subscriptionId }),
      ).rejects.toThrow(/does not belong to this subscription/);
      await expect(attempt({ ...bobs })).rejects.toThrow(
        /belongs to another user/,
      );
      await expect(
        attempt({ periodEnd: inHours(24 * 40, periodStart) }),
      ).rejects.toThrow(/exactly the paid period/);
      await expect(attempt({ paymentId: 'no-such-payment' })).rejects.toThrow(
        /require a succeeded payment/,
      );
      await expect(
        client.creditWallet.count({ where: { authId: alice } }),
      ).resolves.toBe(0);

      // The matching payment is accepted once; a payment funds one allocation.
      await expect(attempt({})).resolves.toMatchObject({ created: true });
      await expect(
        client.$executeRaw`INSERT INTO "CreditAllocation"
          ("id", "walletId", "source", "sourceReference", "grantedCredits", "remainingCredits",
           "expiresAt", "grantedAt", "updatedAt", "subscriptionId", "paymentId", "periodStartsAt")
          SELECT 'second', a."walletId", 'SUBSCRIPTION', 'pro:second', 1, 1, a."expiresAt",
                 a."grantedAt", now(), a."subscriptionId", a."paymentId", a."periodStartsAt"
          FROM "CreditAllocation" a WHERE a."paymentId" = ${paid.paymentId}`,
      ).rejects.toThrow();
      await reconcile(alice);
    });

    it('removes all credit records when the user is deleted (account erasure)', async () => {
      const alice = await newUser();
      const session = await newSession(alice);
      await allocate(alice, CreditSource.TRIAL, 5);
      await wallets.deduct({
        authId: alice,
        credits: 7,
        idempotencyKey: 'erase',
        sessionId: session,
      });

      await client.authUser.delete({ where: { id: alice } });

      const counts = await client.$queryRaw<{ remaining: number }[]>`
        SELECT (SELECT COUNT(*) FROM "CreditWallet" WHERE "authId" = ${alice})::int
             + (SELECT COUNT(*) FROM "CreditSessionOverage" WHERE "sessionId" = ${session})::int AS remaining`;
      expect(counts[0].remaining).toBe(0);
    });
  });
});
