// Must be first: sets REDIS_ENABLED=false (and an unreachable Redis) before
// any application module reads the environment.
import './support/env-postgres-mode';
import { Prisma } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import request from 'supertest';
import { UserRole } from '../src/auth/interfaces/auth.interface';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
import { CreditUsageService } from '../src/credit/credit-usage.service';
import { CreditWalletService } from '../src/credit/credit-wallet.service';
import { RateLimitStore } from '../src/infrastructure/rate-limit/rate-limit.store';
import { FakeOpenRouter } from './support/fake-openrouter';
import {
  bootApplication,
  eventually,
  photo,
  type TestApplication,
} from './support/infrastructure-flows';
import { describeWithDatabase } from './support/migrated-schema';
import { createUser } from './support/subscription-fixtures';

jest.setTimeout(180_000);

interface UsageRow {
  authId: string;
  sessionId: string;
  aiRunId: string;
  operation: string;
  attempt: number;
  provider: string;
  model: string | null;
  providerRequestId: string | null;
  succeeded: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: string | null;
  chargeStatus: string;
  chargedCredits: string | null;
  usdMicrosPerCredit: number | null;
  creditTransactionId: string | null;
}

interface DeductionRow {
  id: string;
  amount: string;
  overage: string;
  costUsd: string | null;
  usdMicrosPerCredit: number | null;
  sessionId: string | null;
  reference: string | null;
}

/**
 * AI usage tracking and credit deductions end to end: the complete
 * application (AppModule over HTTP, PostgreSQL queue worker, live OpenRouter
 * provider) against a local fake of the OpenRouter API that reports token
 * usage and `usage.cost` in US dollars. Every request's usage is stored in
 * PostgreSQL; credits are deducted from the actual cost at the configured
 * conversion rate ($0.005 per credit by default).
 */
describeWithDatabase('AI usage and credit deductions (e2e)', () => {
  const openRouter = new FakeOpenRouter();
  let ctx: TestApplication;
  let users = 0;
  const tokens = new AuthUtilsService(mock<RateLimitStore>());

  beforeAll(async () => {
    const baseUrl = await openRouter.start();
    process.env.AI_MODE = 'live';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-e2e-test-key';
    process.env.OPENROUTER_BASE_URL = baseUrl;
    process.env.OPENROUTER_MODEL = 'openai/gpt-4.1-mini';
    process.env.AI_QUEUE_RATE_LIMIT_MAX = '1000';
    ctx = await bootApplication();
    // Listen once: otherwise supertest starts and closes the server for every
    // request, which resets concurrent requests (ECONNRESET).
    await ctx.app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await ctx?.close();
    await openRouter.stop();
    process.env.AI_MODE = 'mock';
  });

  beforeEach(async () => {
    openRouter.reset();
    await ctx.client.$executeRaw`
      UPDATE "CreditSettings" SET "openRouterUsdMicrosPerCredit" = DEFAULT`;
  });

  const http = () => request(ctx.app.getHttpServer());
  const wallets = () => ctx.get<CreditWalletService>(CreditWalletService);

  /** A verified user with `credits` purchased credits. */
  const newUser = async (credits: number | string) => {
    users += 1;
    const id = await createUser(ctx.client);
    if (Number(credits) > 0) {
      await ctx.client.$queryRaw`
        SELECT "Credit_grant_manual"(${id}, 'PURCHASE'::"CreditSource", ${`usage-e2e:${id}`}, ${String(credits)}::numeric)`;
    }
    const token = tokens.createAccessToken({
      userId: id,
      role: UserRole.USER,
      tokenVersion: 1,
    });
    return { id, auth: `Bearer ${token}`, ip: `198.18.${users % 250}.1` };
  };
  type User = Awaited<ReturnType<typeof newUser>>;

  const data = <T>(response: { body: unknown }) =>
    (response.body as { data: T }).data;

  /** A session with a photo and preferences, ready for analysis. */
  const readySession = async (user: User) => {
    const session = data<{ id: string }>(
      await http()
        .post('/v1/sessions')
        .set('Authorization', user.auth)
        .set('X-Forwarded-For', user.ip)
        .expect(201),
    );
    await http()
      .post(`/v1/sessions/${session.id}/images`)
      .set('Authorization', user.auth)
      .set('X-Forwarded-For', user.ip)
      .field('purpose', 'INITIAL_ANALYSIS')
      .attach('image', await photo(), {
        filename: 'face.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    await http()
      .patch(`/v1/sessions/${session.id}/preferences`)
      .set('Authorization', user.auth)
      .set('X-Forwarded-For', user.ip)
      .send({ vibe: 'natural', timeMinutes: 10 })
      .expect(200);
    return session.id;
  };

  const analyze = async (user: User, sessionId: string, key = sessionId) =>
    data<{ id: string }>(
      await http()
        .post(`/v1/sessions/${sessionId}/analyze`)
        .set('Authorization', user.auth)
        .set('X-Forwarded-For', user.ip)
        .set('Idempotency-Key', `analysis-${key}`)
        .expect(201),
    ).id;

  /** Waits until the run is COMPLETED or FAILED. */
  const settled = (runId: string) =>
    eventually(
      async () => {
        const run = await ctx.client.aiRun.findUniqueOrThrow({
          where: { id: runId },
        });
        return run.status === 'COMPLETED' || run.status === 'FAILED'
          ? run
          : null;
      },
      60_000,
      `AI run ${runId}`,
    );

  const usageOf = (where: Prisma.Sql) =>
    ctx.client.$queryRaw<UsageRow[]>`
      SELECT "authId", "sessionId", "aiRunId", "operation"::text AS operation, "attempt",
             "provider", "model", "providerRequestId", "succeeded", "inputTokens",
             "outputTokens", "totalTokens", "costUsd"::text AS "costUsd",
             "chargeStatus"::text AS "chargeStatus", "chargedCredits"::text AS "chargedCredits",
             "usdMicrosPerCredit", "creditTransactionId"
      FROM "AiUsage" WHERE ${where} ORDER BY "createdAt", "attempt"`;
  const deductionsOf = (userId: string) =>
    ctx.client.$queryRaw<DeductionRow[]>`
      SELECT t."id", t."amountCredits"::text AS amount,
             t."overageChangeCredits"::text AS overage,
             t."costUsd"::text AS "costUsd", t."usdMicrosPerCredit",
             t."sessionId", t."reference"
      FROM "CreditTransaction" t JOIN "CreditWallet" w ON w."id" = t."walletId"
      WHERE w."authId" = ${userId} AND t."type" = 'DEDUCTION'
      ORDER BY t."sequence"`;
  const available = async (userId: string) =>
    (await wallets().getBalance(userId)).availableCredits;

  it('records each OpenRouter request and deducts its actual USD cost ($0.025 = 5 credits)', async () => {
    const user = await newUser(100);
    const sessionId = await readySession(user);
    openRouter.script({ cost: 0.025 });

    const runId = await analyze(user, sessionId);
    await expect(settled(runId)).resolves.toMatchObject({
      status: 'COMPLETED',
    });

    const [usage] = await usageOf(Prisma.sql`"aiRunId" = ${runId}`);
    expect(usage).toEqual({
      authId: user.id,
      sessionId,
      aiRunId: runId,
      operation: 'PERSONALIZATION',
      attempt: 1,
      provider: 'openrouter',
      model: 'openai/gpt-4.1-mini',
      providerRequestId: openRouter.received[0].generationId,
      succeeded: true,
      inputTokens: expect.any(Number) as unknown,
      outputTokens: 200,
      totalTokens: expect.any(Number) as unknown,
      costUsd: '0.025000000000',
      chargeStatus: 'CHARGED',
      chargedCredits: '5.000000',
      usdMicrosPerCredit: 5000,
      creditTransactionId: expect.any(String) as unknown,
    });
    expect(usage.totalTokens).toBe((usage.inputTokens ?? 0) + 200);
    // Usage accounting was requested from OpenRouter.
    expect(openRouter.received[0].usage).toEqual({ include: true });

    await expect(deductionsOf(user.id)).resolves.toEqual([
      {
        id: usage.creditTransactionId,
        amount: '-5.000000',
        overage: '0.000000',
        costUsd: '0.025000000000',
        usdMicrosPerCredit: 5000,
        sessionId,
        reference: `ai-run:${runId}`,
      },
    ]);
    await expect(available(user.id)).resolves.toBe('95');
  });

  it('does not deduct for a free request, but still records it', async () => {
    const user = await newUser(10);
    const sessionId = await readySession(user);
    openRouter.script({ cost: 0 });

    const runId = await analyze(user, sessionId);
    await expect(settled(runId)).resolves.toMatchObject({
      status: 'COMPLETED',
    });

    await expect(
      usageOf(Prisma.sql`"aiRunId" = ${runId}`),
    ).resolves.toMatchObject([
      { costUsd: '0.000000000000', chargeStatus: 'FREE' },
    ]);
    await expect(deductionsOf(user.id)).resolves.toEqual([]);
    await expect(available(user.id)).resolves.toBe('10');
  });

  it('records one usage per request within a session and sums their costs exactly', async () => {
    const user = await newUser(100);
    const sessionId = await readySession(user);
    const costs = [0.0123456789, 0.031, 0.0042, 0.00001];
    openRouter.script(...costs.map((cost) => ({ cost })));

    // Analysis, guide, step check and question: four requests.
    const analysis = await analyze(user, sessionId);
    await settled(analysis);
    const session = data<{ recommendations: { id: string }[] }>(
      await http()
        .get(`/v1/sessions/${sessionId}`)
        .set('Authorization', user.auth)
        .set('X-Forwarded-For', user.ip)
        .expect(200),
    );
    const guide = data<{ id: string }>(
      await http()
        .post(
          `/v1/sessions/${sessionId}/recommendations/${session.recommendations[0].id}/select`,
        )
        .set('Authorization', user.auth)
        .set('X-Forwarded-For', user.ip)
        .set('Idempotency-Key', `guide-${sessionId}`)
        .expect(201),
    ).id;
    await settled(guide);
    const guided = data<{ guide: { steps: { id: string; status: string }[] } }>(
      await http()
        .get(`/v1/sessions/${sessionId}`)
        .set('Authorization', user.auth)
        .set('X-Forwarded-For', user.ip)
        .expect(200),
    );
    const step = guided.guide.steps.find((s) => s.status === 'CURRENT')!;
    const check = data<{ id: string }>(
      await http()
        .post(`/v1/guide-steps/${step.id}/check`)
        .set('Authorization', user.auth)
        .set('X-Forwarded-For', user.ip)
        .set('Idempotency-Key', `check-${step.id}`)
        .attach('image', await photo(90), {
          filename: 'step.jpg',
          contentType: 'image/jpeg',
        })
        .expect(201),
    ).id;
    await settled(check);
    const question = data<{ id: string }>(
      await http()
        .post(`/v1/guide-steps/${step.id}/questions`)
        .set('Authorization', user.auth)
        .set('X-Forwarded-For', user.ip)
        .set('Idempotency-Key', `question-${step.id}`)
        .send({ question: 'How much blush?' })
        .expect(201),
    ).id;
    await settled(question);

    const usages = await usageOf(Prisma.sql`"sessionId" = ${sessionId}`);
    expect(
      usages.map((u) => [u.operation, u.costUsd, u.chargedCredits]),
    ).toEqual([
      ['PERSONALIZATION', '0.012345678900', '2.469136'],
      ['GUIDE_GENERATION', '0.031000000000', '6.200000'],
      ['VISION_CHECK', '0.004200000000', '0.840000'],
      ['GUIDE_QUESTION', '0.000010000000', '0.002000'],
    ]);
    expect(new Set(usages.map((u) => u.aiRunId))).toEqual(
      new Set([analysis, guide, check, question]),
    );
    // Exact sums in PostgreSQL (no floating point).
    const [sums] = await ctx.client.$queryRaw<
      { cost: string; credits: string; deducted: string }[]
    >`
      SELECT (SELECT SUM("costUsd")::text FROM "AiUsage" WHERE "sessionId" = ${sessionId}) AS cost,
             (SELECT SUM("chargedCredits")::text FROM "AiUsage" WHERE "sessionId" = ${sessionId}) AS credits,
             (SELECT SUM(-t."amountCredits" + t."overageChangeCredits")::text
                FROM "CreditTransaction" t WHERE t."sessionId" = ${sessionId} AND t."type" = 'DEDUCTION') AS deducted`;
    expect(sums).toEqual({
      cost: '0.047555678900',
      credits: '9.511136',
      deducted: '9.511136',
    });
    await expect(available(user.id)).resolves.toBe('90.488864');
  });

  it('supports fractional deductions', async () => {
    const user = await newUser(1);
    const sessionId = await readySession(user);
    openRouter.script({ cost: 0.0000123 });

    const runId = await analyze(user, sessionId);
    await settled(runId);

    await expect(deductionsOf(user.id)).resolves.toMatchObject([
      {
        amount: '-0.002460',
        costUsd: '0.000012300000',
        usdMicrosPerCredit: 5000,
      },
    ]);
    await expect(available(user.id)).resolves.toBe('0.99754');
  });

  it('applies a changed conversion rate to later requests only', async () => {
    const user = await newUser(100);
    const admin = await createUser(ctx.client);
    await ctx.client.authUser.update({
      where: { id: admin },
      data: { role: 'ADMIN' },
    });
    const adminAuth = `Bearer ${tokens.createAccessToken({ userId: admin, role: UserRole.ADMIN, tokenVersion: 1 })}`;

    const first = await analyze(user, await readySession(user));
    await settled(first);
    await http()
      .patch('/v1/admin/credit-settings')
      .set('Authorization', adminAuth)
      .send({ openRouterUsdMicrosPerCredit: 2500 })
      .expect(200);
    const second = await analyze(user, await readySession(user));
    await settled(second);

    await expect(deductionsOf(user.id)).resolves.toMatchObject([
      // Charged before the change: 5 credits at $0.005, unchanged.
      {
        amount: '-5.000000',
        costUsd: '0.025000000000',
        usdMicrosPerCredit: 5000,
        reference: `ai-run:${first}`,
      },
      // After the change: the same cost is 10 credits at $0.0025.
      {
        amount: '-10.000000',
        costUsd: '0.025000000000',
        usdMicrosPerCredit: 2500,
        reference: `ai-run:${second}`,
      },
    ]);
    await expect(
      usageOf(Prisma.sql`"authId" = ${user.id}`),
    ).resolves.toMatchObject([
      { chargedCredits: '5.000000', usdMicrosPerCredit: 5000 },
      { chargedCredits: '10.000000', usdMicrosPerCredit: 2500 },
    ]);
    await expect(available(user.id)).resolves.toBe('85');
  });

  it('never deducts again for retried attempts, duplicate requests or re-processed responses', async () => {
    const user = await newUser(100);
    const sessionId = await readySession(user);
    // Attempt 1 is answered and billed but unusable; the job retries.
    openRouter.script({ cost: 0.01, invalidJson: true }, { cost: 0.02 });

    const runId = await analyze(user, sessionId, 'retry');
    await expect(settled(runId)).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    const usages = await usageOf(Prisma.sql`"aiRunId" = ${runId}`);
    expect(
      usages.map((u) => [
        u.attempt,
        u.succeeded,
        u.costUsd,
        u.chargeStatus,
        u.chargedCredits,
      ]),
    ).toEqual([
      [1, false, '0.010000000000', 'NOT_CHARGED', null],
      [2, true, '0.020000000000', 'CHARGED', '4.000000'],
    ]);

    // The client repeats the request: the same run, no new provider request.
    const requestsBefore = openRouter.received.length;
    await expect(analyze(user, sessionId, 'retry')).resolves.toBe(runId);
    // The same response is recorded and charged again (e.g. re-processed).
    const service = ctx.get<CreditUsageService>(CreditUsageService);
    const charged = usages[1];
    const again = await service.recordUsage(
      {
        authId: user.id,
        sessionId,
        aiRunId: runId,
        operation: 'PERSONALIZATION',
        attempt: 2,
      },
      {
        provider: 'openrouter',
        providerRequestId: charged.providerRequestId!,
        succeeded: true,
        costUsd: 0.02,
      },
    );
    await ctx.client.$transaction((tx) =>
      service.chargeInTransaction(tx, again.id),
    );

    expect(openRouter.received.length).toBe(requestsBefore);
    await expect(
      usageOf(Prisma.sql`"aiRunId" = ${runId}`),
    ).resolves.toHaveLength(2);
    await expect(deductionsOf(user.id)).resolves.toHaveLength(1);
    await expect(available(user.id)).resolves.toBe('96');
  });

  it('keeps deductions exact when several sessions are processed in parallel', async () => {
    const user = await newUser(100);
    const sessions = await Promise.all(
      Array.from({ length: 6 }, () => readySession(user)),
    );
    const costs = [0.011, 0.012, 0.013, 0.014, 0.015, 0.016];
    openRouter.script(...costs.map((cost) => ({ cost })));

    const runs = await Promise.all(sessions.map((id) => analyze(user, id)));
    const results = await Promise.all(runs.map((id) => settled(id)));

    expect(results.every((run) => run.status === 'COMPLETED')).toBe(true);
    const deductions = await deductionsOf(user.id);
    expect(deductions).toHaveLength(6);
    // $0.081 in total at $0.005 per credit: 16.2 credits.
    await expect(available(user.id)).resolves.toBe('83.8');
    const [wallet] = await ctx.client.$queryRaw<
      { balance: string; ledger: string }[]
    >`
      SELECT w."balanceCredits"::text AS balance,
             (SELECT t."balanceAfterCredits"::text FROM "CreditTransaction" t
               WHERE t."walletId" = w."id" ORDER BY t."sequence" DESC LIMIT 1) AS ledger
      FROM "CreditWallet" w WHERE w."authId" = ${user.id}`;
    expect(wallet).toEqual({ balance: '83.800000', ledger: '83.800000' });
  });

  it('fails a run whose cost exceeds the credits and session overage, and refuses requests once nothing is spendable', async () => {
    const user = await newUser(1);
    const sessionId = await readySession(user);

    // 1 credit + 5 overage credits cannot pay $0.05 (10 credits).
    openRouter.script({ cost: 0.05 });
    const tooExpensive = await analyze(user, sessionId, 'expensive');
    await expect(settled(tooExpensive)).resolves.toMatchObject({
      status: 'FAILED',
      error: 'Insufficient credits',
    });
    await expect(
      usageOf(Prisma.sql`"aiRunId" = ${tooExpensive}`),
    ).resolves.toMatchObject([
      { chargeStatus: 'INSUFFICIENT_CREDITS', chargedCredits: null },
    ]);
    await expect(deductionsOf(user.id)).resolves.toEqual([]);

    // $0.03 (6 credits) uses the credit and the whole session overage.
    openRouter.script({ cost: 0.03 });
    const paid = await analyze(user, sessionId, 'paid');
    await expect(settled(paid)).resolves.toMatchObject({ status: 'COMPLETED' });
    await expect(deductionsOf(user.id)).resolves.toMatchObject([
      { amount: '-1.000000', overage: '5.000000', costUsd: '0.030000000000' },
    ]);

    // Nothing is spendable any more: selecting a look queues the guide run,
    // which fails before any provider request is made.
    const requestsBefore = openRouter.received.length;
    const ready = data<{ recommendations: { id: string }[] }>(
      await http()
        .get(`/v1/sessions/${sessionId}`)
        .set('Authorization', user.auth)
        .set('X-Forwarded-For', user.ip)
        .expect(200),
    );
    const refused = data<{ id: string }>(
      await http()
        .post(
          `/v1/sessions/${sessionId}/recommendations/${ready.recommendations[0].id}/select`,
        )
        .set('Authorization', user.auth)
        .set('X-Forwarded-For', user.ip)
        .set('Idempotency-Key', `guide-${sessionId}`)
        .expect(201),
    ).id;
    await expect(settled(refused)).resolves.toMatchObject({
      status: 'FAILED',
      error: 'Insufficient credits',
    });
    expect(openRouter.received.length).toBe(requestsBefore);
    await expect(usageOf(Prisma.sql`"aiRunId" = ${refused}`)).resolves.toEqual(
      [],
    );
  });
});
