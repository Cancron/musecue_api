// Must be first: sets REDIS_ENABLED=false (and an unreachable Redis) before
// any application module reads the environment.
import './support/env-postgres-mode';
import { mock } from 'jest-mock-extended';
import { UserRole } from '../src/auth/interfaces/auth.interface';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
import { CreditExpirySweepService } from '../src/credit/credit-expiry-sweep.service';
import { CreditWalletService } from '../src/credit/credit-wallet.service';
import { RateLimitStore } from '../src/infrastructure/rate-limit/rate-limit.store';
import { bootLiveAiApplication, makeupClient } from './support/credit-ai-app';
import { FakeOpenRouter } from './support/fake-openrouter';
import type { TestApplication } from './support/infrastructure-flows';
import { describeWithDatabase } from './support/migrated-schema';
import { createUser } from './support/subscription-fixtures';

jest.setTimeout(240_000);

interface WalletState {
  balance: string;
  outstanding: string;
  ledgerBalance: string;
  ledgerOverage: string;
  sessionOverage: string;
}

interface SessionOverageRow {
  authId: string;
  sessionId: string;
  limit: string;
  overage: string;
  settled: string;
}

/**
 * Session credit overage and concurrency control end to end: the complete
 * application over HTTP with live AI against a fake OpenRouter (costs in
 * USD converted at $0.005 per credit), checked in the PostgreSQL records.
 */
describeWithDatabase('Session credit overage and concurrency (e2e)', () => {
  const openRouter = new FakeOpenRouter();
  let ctx: TestApplication;
  let api: ReturnType<typeof makeupClient>;

  beforeAll(async () => {
    ctx = await bootLiveAiApplication(openRouter);
    api = makeupClient(ctx);
  });

  afterAll(async () => {
    await ctx?.close();
    await openRouter.stop();
    process.env.AI_MODE = 'mock';
  });

  beforeEach(async () => {
    openRouter.reset();
    await ctx.client.$executeRaw`
      UPDATE "CreditSettings"
      SET "sessionOverageAllowanceCredits" = DEFAULT, "openRouterUsdMicrosPerCredit" = DEFAULT`;
  });

  /** Wallet totals and their reconciliation with ledger and session rows. */
  const walletOf = async (authId: string): Promise<WalletState> => {
    const [row] = await ctx.client.$queryRaw<WalletState[]>`
      SELECT w."balanceCredits"::text AS balance,
             w."outstandingOverageCredits"::text AS outstanding,
             COALESCE((SELECT SUM(t."amountCredits") FROM "CreditTransaction" t WHERE t."walletId" = w."id"), 0)::numeric(20,6)::text AS "ledgerBalance",
             COALESCE((SELECT SUM(t."overageChangeCredits") FROM "CreditTransaction" t WHERE t."walletId" = w."id"), 0)::numeric(20,6)::text AS "ledgerOverage",
             COALESCE((SELECT SUM(o."overageCredits" - o."settledCredits") FROM "CreditSessionOverage" o WHERE o."walletId" = w."id"), 0)::numeric(20,6)::text AS "sessionOverage"
      FROM "CreditWallet" w WHERE w."authId" = ${authId}`;
    return row;
  };
  /** The wallet is consistent: ledger, session overage and totals agree. */
  const expectConsistent = (state: WalletState) => {
    expect(state.ledgerBalance).toBe(state.balance);
    expect(state.ledgerOverage).toBe(state.outstanding);
    expect(state.sessionOverage).toBe(state.outstanding);
    expect(Number(state.balance)).toBeGreaterThanOrEqual(0);
  };
  const overageRowsOf = (authId: string) =>
    ctx.client.$queryRaw<SessionOverageRow[]>`
      SELECT w."authId", o."sessionId", o."limitCredits"::text AS limit,
             o."overageCredits"::text AS overage, o."settledCredits"::text AS settled
      FROM "CreditSessionOverage" o JOIN "CreditWallet" w ON w."id" = o."walletId"
      WHERE w."authId" = ${authId} ORDER BY o."createdAt"`;
  const deductionsOf = (authId: string) =>
    ctx.client.$queryRaw<
      {
        amount: string;
        overage: string;
        sessionId: string;
        reference: string;
        costUsd: string;
      }[]
    >`
      SELECT t."amountCredits"::text AS amount, t."overageChangeCredits"::text AS overage,
             t."sessionId", t."reference", t."costUsd"::text AS "costUsd"
      FROM "CreditTransaction" t JOIN "CreditWallet" w ON w."id" = t."walletId"
      WHERE w."authId" = ${authId} AND t."type" = 'DEDUCTION' ORDER BY t."sequence"`;
  const usageStatuses = async (authId: string) =>
    (
      await ctx.client.aiUsage.findMany({
        where: { authId },
        orderBy: [{ createdAt: 'asc' }, { attempt: 'asc' }],
        select: { chargeStatus: true },
      })
    ).map((usage) => usage.chargeStatus);

  const setAllowance = async (credits: number) => {
    const admin = await createUser(ctx.client);
    await ctx.client.authUser.update({
      where: { id: admin },
      data: { role: 'ADMIN' },
    });
    const token = new AuthUtilsService(
      mock<RateLimitStore>(),
    ).createAccessToken({
      userId: admin,
      role: UserRole.ADMIN,
      tokenVersion: 1,
    });
    await api
      .http()
      .patch('/v1/admin/credit-settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionOverageAllowanceCredits: credits })
      .expect(200);
  };

  describe('session overage', () => {
    it('completes a session started with 1 credit that uses 6: 1 credit deducted and 5 as overage, never a negative balance', async () => {
      const user = await api.newUser(1);
      const sessionId = await api.readySession(user);

      // Analysis $0.01 (2 credits) and guide $0.02 (4 credits): 6 in total.
      openRouter.script({ cost: 0.01 }, { cost: 0.02 });
      const analysis = await api.analyze(user, sessionId);
      await expect(api.settled(analysis)).resolves.toMatchObject({
        status: 'COMPLETED',
      });
      const guide = await api.selectFirstLook(user, sessionId);
      await expect(api.settled(guide)).resolves.toMatchObject({
        status: 'COMPLETED',
      });

      await expect(deductionsOf(user.id)).resolves.toEqual([
        {
          amount: '-1.000000',
          overage: '1.000000',
          sessionId,
          reference: `ai-run:${analysis}`,
          costUsd: '0.010000000000',
        },
        {
          amount: '0.000000',
          overage: '4.000000',
          sessionId,
          reference: `ai-run:${guide}`,
          costUsd: '0.020000000000',
        },
      ]);
      await expect(overageRowsOf(user.id)).resolves.toEqual([
        {
          authId: user.id,
          sessionId,
          limit: '5.000000',
          overage: '5.000000',
          settled: '0.000000',
        },
      ]);
      const wallet = await walletOf(user.id);
      expect(wallet).toMatchObject({
        balance: '0.000000',
        outstanding: '5.000000',
      });
      expectConsistent(wallet);

      // Any further session is refused.
      const refused = await api.createSession(user).expect(403);
      expect(refused.body).toMatchObject({
        statusCode: 403,
        message: 'Insufficient credits',
      });
      // The session's overage is used up: no more AI requests are made.
      const requestsBefore = openRouter.received.length;
      const step = await api.currentStep(user, sessionId);
      const check = await api.checkStep(user, step, 'after-overage');
      await expect(api.settled(check)).resolves.toMatchObject({
        status: 'FAILED',
        error: 'Insufficient credits',
      });
      expect(openRouter.received.length).toBe(requestsBefore);
      await expect(deductionsOf(user.id)).resolves.toHaveLength(2);
    });

    it('uses the overage allowance configured by the administrator', async () => {
      await setAllowance(2);
      const user = await api.newUser(1);
      const sessionId = await api.readySession(user);

      // $0.0175 = 3.5 credits > 1 + 2: refused, nothing deducted.
      openRouter.script({ cost: 0.0175 });
      const tooMuch = await api.analyze(user, sessionId, 'too-much');
      await expect(api.settled(tooMuch)).resolves.toMatchObject({
        status: 'FAILED',
        error: 'Insufficient credits',
      });
      await expect(deductionsOf(user.id)).resolves.toEqual([]);

      // $0.015 = 3 credits = 1 + 2 overage: completes.
      openRouter.script({ cost: 0.015 });
      const fits = await api.analyze(user, sessionId, 'fits');
      await expect(api.settled(fits)).resolves.toMatchObject({
        status: 'COMPLETED',
      });
      await expect(overageRowsOf(user.id)).resolves.toMatchObject([
        { sessionId, limit: '2.000000', overage: '2.000000' },
      ]);
      expectConsistent(await walletOf(user.id));
    });

    it('gives no overage to other sessions once the credits are spent, and caps it across sessions', async () => {
      const user = await api.newUser(3);
      const [first, second, third] = [
        await api.readySession(user),
        await api.readySession(user),
        await api.readySession(user),
      ];

      // First: 2 credits from the balance. Second: the last credit + 3 overage.
      openRouter.script({ cost: 0.01 }, { cost: 0.02 });
      await api.settled(await api.analyze(user, first));
      await api.settled(await api.analyze(user, second));
      expect((await walletOf(user.id)).outstanding).toBe('3.000000');

      // Third never had credits: refused before any AI request.
      const requestsBefore = openRouter.received.length;
      const third1 = await api.analyze(user, third);
      await expect(api.settled(third1)).resolves.toMatchObject({
        status: 'FAILED',
        error: 'Insufficient credits',
      });
      expect(openRouter.received.length).toBe(requestsBefore);

      // First was funded, but only 2 of the user's allowance of 5 are left:
      // its $0.02 (4 credits) guide cannot be paid and is not published.
      openRouter.script({ cost: 0.02 });
      const guide = await api.selectFirstLook(user, first);
      await expect(api.settled(guide)).resolves.toMatchObject({
        status: 'FAILED',
        error: 'Insufficient credits',
      });
      await expect(usageStatuses(user.id)).resolves.toEqual([
        'CHARGED',
        'CHARGED',
        'INSUFFICIENT_CREDITS',
      ]);

      const wallet = await walletOf(user.id);
      expect(wallet).toMatchObject({
        balance: '0.000000',
        outstanding: '3.000000',
      });
      expectConsistent(wallet);
      await expect(overageRowsOf(user.id)).resolves.toMatchObject([
        { sessionId: second, overage: '3.000000' },
      ]);
      await api.createSession(user).expect(403);
    });
  });

  describe('concurrency control', () => {
    it('lets only one of several concurrent sessions spend a single credit and the overage', async () => {
      const user = await api.newUser(1);
      const sessions = await Promise.all(
        Array.from({ length: 4 }, () => api.readySession(user)),
      );
      openRouter.defaultCost = 0.03; // 6 credits each

      const runs = await Promise.all(
        sessions.map((sessionId) => api.analyze(user, sessionId)),
      );
      const results = await Promise.all(runs.map((id) => api.settled(id)));

      expect(results.filter((r) => r.status === 'COMPLETED')).toHaveLength(1);
      expect(
        results.filter((r) => r.status === 'FAILED').map((r) => r.error),
      ).toEqual(Array(3).fill('Insufficient credits'));
      await expect(deductionsOf(user.id)).resolves.toEqual([
        expect.objectContaining({ amount: '-1.000000', overage: '5.000000' }),
      ]);
      await expect(overageRowsOf(user.id)).resolves.toHaveLength(1);
      const wallet = await walletOf(user.id);
      expect(wallet).toMatchObject({
        balance: '0.000000',
        outstanding: '5.000000',
      });
      expectConsistent(wallet);
    });

    it('keeps deductions and overage exact when concurrent sessions run out of credits', async () => {
      const user = await api.newUser(10);
      const sessions = await Promise.all(
        Array.from({ length: 5 }, () => api.readySession(user)),
      );
      openRouter.defaultCost = 0.012; // 2.4 credits each, 12 in total

      const runs = await Promise.all(
        sessions.map((sessionId) => api.analyze(user, sessionId)),
      );
      const results = await Promise.all(runs.map((id) => api.settled(id)));

      // 10 credits from the balance + 2 as overage: everything completes.
      expect(results.every((r) => r.status === 'COMPLETED')).toBe(true);
      const deductions = await deductionsOf(user.id);
      expect(deductions).toHaveLength(5);
      expect(
        deductions.reduce(
          (sum, d) => sum - Number(d.amount) + Number(d.overage),
          0,
        ),
      ).toBeCloseTo(12, 9);
      const wallet = await walletOf(user.id);
      expect(wallet).toMatchObject({
        balance: '0.000000',
        outstanding: '2.000000',
      });
      expectConsistent(wallet);
      await expect(overageRowsOf(user.id)).resolves.toHaveLength(1);
    });

    it("makes concurrent funded sessions share the user's overage allowance", async () => {
      const user = await api.newUser(3);
      const sessions = [
        await api.readySession(user),
        await api.readySession(user),
        await api.readySession(user),
      ];
      // Each session spends 1 credit first: all three are funded, balance 0.
      openRouter.defaultCost = 0.005;
      for (const sessionId of sessions) {
        await api.settled(await api.analyze(user, sessionId));
      }
      expect((await walletOf(user.id)).balance).toBe('0.000000');

      // Now all three generate a guide at once, $0.02 (4 credits) each: each
      // session alone could use 4 overage, but the user may owe only 5.
      openRouter.defaultCost = 0.02;
      const runs = await Promise.all(
        sessions.map((sessionId) => api.selectFirstLook(user, sessionId)),
      );
      const results = await Promise.all(runs.map((id) => api.settled(id)));

      expect(results.filter((r) => r.status === 'COMPLETED')).toHaveLength(1);
      expect(
        results.filter((r) => r.status === 'FAILED').map((r) => r.error),
      ).toEqual(['Insufficient credits', 'Insufficient credits']);
      const wallet = await walletOf(user.id);
      expect(wallet).toMatchObject({
        balance: '0.000000',
        outstanding: '4.000000',
      });
      expectConsistent(wallet);
      await expect(overageRowsOf(user.id)).resolves.toHaveLength(1);
    });

    it('keeps one session consistent when several of its requests are charged at once', async () => {
      const user = await api.newUser(2);
      const sessionId = await api.readySession(user);
      // Analysis $0.005 (1) and guide $0.0025 (0.5): 0.5 credit left.
      openRouter.script({ cost: 0.005 }, { cost: 0.0025 });
      await api.settled(await api.analyze(user, sessionId));
      await api.settled(await api.selectFirstLook(user, sessionId));
      const step = await api.currentStep(user, sessionId);

      // Three $0.01 (2 credit) requests at once: 6 credits against 0.5 + 5.
      openRouter.defaultCost = 0.01;
      const runs = await Promise.all([
        api.checkStep(user, step, 'parallel-check'),
        api.ask(user, step, 'parallel-q1'),
        api.ask(user, step, 'parallel-q2'),
      ]);
      const results = await Promise.all(runs.map((id) => api.settled(id)));

      expect(results.filter((r) => r.status === 'COMPLETED')).toHaveLength(2);
      expect(results.filter((r) => r.status === 'FAILED')).toEqual([
        expect.objectContaining({ error: 'Insufficient credits' }),
      ]);
      const wallet = await walletOf(user.id);
      expect(wallet).toMatchObject({
        balance: '0.000000',
        outstanding: '3.500000',
      });
      expectConsistent(wallet);
      await expect(overageRowsOf(user.id)).resolves.toMatchObject([
        { sessionId, overage: '3.500000' },
      ]);
      await expect(deductionsOf(user.id)).resolves.toHaveLength(4);
    });
  });

  describe('interrupted and unsuccessful OpenRouter requests', () => {
    it('charges a retried run once: failed and unusable attempts add no deduction or overage', async () => {
      const user = await api.newUser(1);
      const sessionId = await api.readySession(user);
      // Attempt 1: OpenRouter unavailable (no answer, no usage). Attempt 2:
      // answered and billed but unusable. Attempt 3: $0.03 (6 credits).
      openRouter.script(
        { httpStatus: 503 },
        { cost: 0.02, invalidJson: true },
        { cost: 0.03 },
      );

      const runId = await api.analyze(user, sessionId);
      await expect(api.settled(runId)).resolves.toMatchObject({
        status: 'COMPLETED',
      });

      const usages = await ctx.client.aiUsage.findMany({
        where: { aiRunId: runId },
        orderBy: { attempt: 'asc' },
      });
      expect(
        usages.map((u) => [u.attempt, u.succeeded, u.chargeStatus]),
      ).toEqual([
        [2, false, 'NOT_CHARGED'],
        [3, true, 'CHARGED'],
      ]);
      await expect(deductionsOf(user.id)).resolves.toEqual([
        expect.objectContaining({
          amount: '-1.000000',
          overage: '5.000000',
          reference: `ai-run:${runId}`,
        }),
      ]);
      await expect(overageRowsOf(user.id)).resolves.toMatchObject([
        { sessionId, overage: '5.000000' },
      ]);
      expectConsistent(await walletOf(user.id));
    });

    it('deducts nothing for a run that never succeeds, leaving the overage for later requests', async () => {
      const user = await api.newUser(1);
      const sessionId = await api.readySession(user);
      openRouter.script(
        { cost: 0.01, invalidJson: true },
        { cost: 0.01, invalidJson: true },
        { cost: 0.01, invalidJson: true },
      );

      const failed = await api.analyze(user, sessionId, 'failing');
      await expect(api.settled(failed)).resolves.toMatchObject({
        status: 'FAILED',
      });
      await expect(usageStatuses(user.id)).resolves.toEqual(
        Array(3).fill('NOT_CHARGED'),
      );
      await expect(deductionsOf(user.id)).resolves.toEqual([]);
      await expect(overageRowsOf(user.id)).resolves.toEqual([]);

      // The session still has its credit and full overage.
      openRouter.script({ cost: 0.03 });
      const retried = await api.analyze(user, sessionId, 'again');
      await expect(api.settled(retried)).resolves.toMatchObject({
        status: 'COMPLETED',
      });
      await expect(overageRowsOf(user.id)).resolves.toMatchObject([
        { overage: '5.000000' },
      ]);
    });

    it('reconciles usage left pending by an interrupted worker without charging it', async () => {
      const user = await api.newUser(10);
      const sessionId = await api.readySession(user);
      openRouter.script({ cost: 0.01 });
      const runId = await api.analyze(user, sessionId);
      await api.settled(runId);
      const before = {
        deductions: await deductionsOf(user.id),
        wallet: await walletOf(user.id),
      };

      // An earlier attempt's response was recorded, then the worker died
      // before publishing: its usage was left PENDING.
      const orphan = await ctx.client.aiUsage.create({
        data: {
          authId: user.id,
          sessionId,
          aiRunId: runId,
          operation: 'PERSONALIZATION',
          attempt: 1,
          provider: 'openrouter',
          providerRequestId: `gen-interrupted-${runId}`,
          succeeded: true,
          costUsd: '0.01',
        },
      });
      const sweep = await ctx
        .get<CreditExpirySweepService>(CreditExpirySweepService)
        .sweep();

      expect(sweep?.reconciledUsages).toBeGreaterThanOrEqual(1);
      await expect(
        ctx.client.aiUsage.findUniqueOrThrow({ where: { id: orphan.id } }),
      ).resolves.toMatchObject({ chargeStatus: 'NOT_CHARGED' });
      await expect(deductionsOf(user.id)).resolves.toEqual(before.deductions);
      await expect(walletOf(user.id)).resolves.toEqual(before.wallet);
    });
  });

  describe('tracking in PostgreSQL', () => {
    it("records overage only for a makeup session of the wallet's own user", async () => {
      const owner = await api.newUser(1);
      const other = await api.newUser(1);
      const othersSession = await api.readySession(other);
      const wallet = await ctx.client.creditWallet.findUniqueOrThrow({
        where: { authId: owner.id },
      });

      await expect(
        ctx.client.$transaction(async (tx) => {
          await tx.$executeRaw`
            INSERT INTO "CreditSessionOverage"
              ("id", "walletId", "sessionId", "limitCredits", "overageCredits", "updatedAt")
            VALUES ('forged', ${wallet.id}, ${othersSession}, 5, 1, now())`;
        }),
      ).rejects.toThrow(/must belong to a makeup session of the wallet/);
      await expect(
        ctx.get<CreditWalletService>(CreditWalletService).deduct({
          authId: owner.id,
          credits: 1,
          idempotencyKey: 'foreign-session',
          sessionId: othersSession,
        }),
      ).rejects.toMatchObject({ status: 404 });
      expectConsistent(await walletOf(owner.id));
    });
  });
});
