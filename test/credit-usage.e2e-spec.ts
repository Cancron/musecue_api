// Must be first: PostgreSQL-only infrastructure (no Redis) and local storage,
// set before any application module reads the environment.
import './support/env-postgres-mode';
import { Prisma, userStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { CreditSettingsService } from '../src/credits/credit-settings.service';
import { CreditUsageService } from '../src/credits/credit-usage.service';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import {
  expectConsistentLedger,
  givenCreditsInPostgres,
} from './support/credit-fixtures';
import { FakeOpenRouter, MODEL } from './support/fake-openrouter';
import {
  bootApplication,
  eventually,
  photo,
  type TestApplication,
} from './support/infrastructure-flows';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(240_000);

const D = (value: string | number) => new Prisma.Decimal(value);
const PASSWORD = 'credit usage e2e password';

interface Envelope<T> {
  data: T;
}
const dataOf = <T>(response: { body: unknown }) =>
  (response.body as Envelope<T>).data;

interface Account {
  id: string;
  auth: string;
  ip: string;
}

/**
 * AI usage tracking and credit deductions through the complete application
 * (AppModule, real HTTP endpoints, the PostgreSQL job worker and the live
 * OpenRouter provider) against a migrated PostgreSQL schema. OpenRouter is
 * replaced by a local HTTP server that answers like OpenRouter (structured
 * output, usage tokens and cost in USD); nothing external is contacted.
 */
describeWithDatabase('AI usage tracking and credit deductions (e2e)', () => {
  const openRouter = new FakeOpenRouter();
  let ctx: TestApplication;
  let ipCounter = 0;

  const http = () => request(ctx.app.getHttpServer());
  const wallet = () => ctx.get<CreditWalletService>(CreditWalletService);
  const settings = () => ctx.get<CreditSettingsService>(CreditSettingsService);

  /** A verified user with purchased credits, signed in over HTTP. */
  const customer = async (credits = '100'): Promise<Account> => {
    const tag = randomBytes(5).toString('hex');
    const email = `usage_${tag}@example.com`;
    const user = await ctx.client.authUser.create({
      data: {
        email,
        username: `usage_${tag}`,
        password: await bcrypt.hash(PASSWORD, 4),
        verified: true,
        status: userStatus.ACTIVE,
      },
    });
    await givenCreditsInPostgres(ctx.client, user.id, 'PURCHASE', credits);
    ipCounter += 1;
    const ip = `10.77.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
    const login = await http()
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: PASSWORD })
      .expect(201);
    return {
      id: user.id,
      ip,
      auth: `Bearer ${dataOf<{ accessToken: string }>(login).accessToken}`,
    };
  };
  const as = (account: Account, req: request.Test) =>
    req.set('Authorization', account.auth).set('X-Forwarded-For', account.ip);

  /**
   * Waits for a run to finish (polling PostgreSQL, so parallel runs stay
   * within the API's rate limits), then reads it through GET /v1/jobs/:id.
   */
  const finished = async (account: Account, runId: string) => {
    await eventually(
      async () => {
        const run = await ctx.client.aiRun.findUnique({
          where: { id: runId },
          select: { status: true },
        });
        return run && ['COMPLETED', 'FAILED'].includes(run.status);
      },
      60_000,
      `AI run ${runId}`,
    );
    return dataOf<{ status: string; error: string | null }>(
      await as(account, http().get(`/v1/jobs/${runId}`)).expect(200),
    );
  };

  /** A session through analysis and guide generation; returns its step. */
  const sessionWithGuide = async (account: Account) => {
    const session = dataOf<{ id: string }>(
      await as(account, http().post('/v1/sessions')).expect(201),
    );
    await as(account, http().post(`/v1/sessions/${session.id}/images`))
      .field('purpose', 'INITIAL_ANALYSIS')
      .attach('image', await photo(), {
        filename: 'face.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    await as(account, http().patch(`/v1/sessions/${session.id}/preferences`))
      .send({ vibe: 'natural', timeMinutes: 10 })
      .expect(200);
    const analysis = dataOf<{ id: string }>(
      await as(account, http().post(`/v1/sessions/${session.id}/analyze`))
        .set('Idempotency-Key', `analysis-${session.id}`)
        .expect(201),
    );
    expect(await finished(account, analysis.id)).toMatchObject({
      status: 'COMPLETED',
    });
    const ready = dataOf<{ recommendations: Array<{ id: string }> }>(
      await as(account, http().get(`/v1/sessions/${session.id}`)).expect(200),
    );
    const guide = dataOf<{ id: string }>(
      await as(
        account,
        http().post(
          `/v1/sessions/${session.id}/recommendations/${ready.recommendations[0].id}/select`,
        ),
      )
        .set('Idempotency-Key', `guide-${session.id}`)
        .expect(201),
    );
    expect(await finished(account, guide.id)).toMatchObject({
      status: 'COMPLETED',
    });
    const guided = dataOf<{
      guide: { steps: Array<{ id: string; status: string }> };
    }>(await as(account, http().get(`/v1/sessions/${session.id}`)).expect(200));
    const step = guided.guide.steps.find((s) => s.status === 'CURRENT');
    return {
      sessionId: session.id,
      stepId: step?.id as string,
      runIds: [analysis.id, guide.id],
    };
  };

  const ask = async (account: Account, stepId: string, key: string) =>
    dataOf<{ id: string }>(
      await as(account, http().post(`/v1/guide-steps/${stepId}/questions`))
        .set('Idempotency-Key', key)
        .send({ question: 'How much blush should I use?' })
        .expect(201),
    );

  const usagesOfRun = (runId: string) =>
    ctx.client.aiUsage.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });
  const debitsOf = (authId: string) =>
    ctx.client.creditTransaction.findMany({
      where: { authId, type: 'DEBIT' },
      orderBy: { sequence: 'asc' },
    });

  beforeAll(async () => {
    await openRouter.start();
    process.env.AI_MODE = 'live';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-e2e-test-key';
    process.env.OPENROUTER_BASE_URL = openRouter.url;
    process.env.OPENROUTER_MODEL = MODEL;
    // The fake answers at once; the production AI rate limit (15 runs per
    // minute) would only slow the many runs of this file down.
    process.env.AI_QUEUE_RATE_LIMIT_MAX = '1000';
    ctx = await bootApplication();
  });

  afterAll(async () => {
    await ctx?.close();
    await openRouter.stop();
    delete process.env.AI_QUEUE_RATE_LIMIT_MAX;
  });

  it('records every OpenRouter request of a session against the user, session and run, and deducts credits for the actual cost', async () => {
    const account = await customer('100');
    const { sessionId, stepId, runIds } = await sessionWithGuide(account);
    const check = dataOf<{ id: string }>(
      await as(account, http().post(`/v1/guide-steps/${stepId}/check`))
        .set('Idempotency-Key', `check-${stepId}`)
        .attach('image', await photo(90), {
          filename: 'step.jpg',
          contentType: 'image/jpeg',
        })
        .expect(201),
    );
    await finished(account, check.id);
    const question = await ask(account, stepId, `question-${stepId}`);
    await finished(account, question.id);
    const allRuns = [...runIds, check.id, question.id];

    const usages = await ctx.client.aiUsage.findMany({
      where: { sessionId },
      orderBy: { occurredAt: 'asc' },
    });
    expect(
      usages.map((u) => [
        u.runId,
        u.operation,
        u.model,
        u.inputTokens,
        u.outputTokens,
        u.totalTokens,
        u.costUsd?.toFixed(),
        u.chargeStatus,
        u.creditCostUsdMicros,
        u.creditsExact?.toFixed(),
        u.creditsDue?.toFixed(),
        u.creditsCharged?.toFixed(),
      ]),
    ).toEqual([
      [
        allRuns[0],
        'PERSONALIZATION',
        MODEL,
        1000,
        250,
        1250,
        '0.025',
        'CHARGED',
        5000,
        '5',
        '5',
        '5',
      ],
      [
        allRuns[1],
        'GUIDE_GENERATION',
        MODEL,
        1000,
        250,
        1250,
        '0.0117',
        'CHARGED',
        5000,
        '2.34',
        '2.34',
        '2.34',
      ],
      [
        allRuns[2],
        'VISION_CHECK',
        MODEL,
        1000,
        250,
        1250,
        '0.000123',
        'CHARGED',
        5000,
        '0.0246',
        '0.0246',
        '0.0246',
      ],
      [
        allRuns[3],
        'GUIDE_QUESTION',
        MODEL,
        1000,
        250,
        1250,
        '0.0045',
        'CHARGED',
        5000,
        '0.9',
        '0.9',
        '0.9',
      ],
    ]);
    expect(usages.every((u) => u.authId === account.id)).toBe(true);
    expect(new Set(usages.map((u) => u.providerRequestId)).size).toBe(4);
    // Usage accounting was requested from OpenRouter every time.
    expect(
      openRouter.requests.every(
        (r) => JSON.stringify(r.usage) === '{"include":true}',
      ),
    ).toBe(true);

    // Each deduction keeps the cost, the rate and the credits deducted.
    const debits = await debitsOf(account.id);
    expect(
      debits.map((t) => [
        t.idempotencyKey,
        t.sessionId,
        t.usageCostUsd?.toFixed(),
        t.creditCostUsdMicros,
        t.amount.toFixed(),
      ]),
    ).toEqual([
      // $0.025 at the default $0.005 per credit: exactly 5 credits.
      [`debit:ai-run:${allRuns[0]}`, sessionId, '0.025', 5000, '-5'],
      [`debit:ai-run:${allRuns[1]}`, sessionId, '0.0117', 5000, '-2.34'],
      [`debit:ai-run:${allRuns[2]}`, sessionId, '0.000123', 5000, '-0.0246'],
      [`debit:ai-run:${allRuns[3]}`, sessionId, '0.0045', 5000, '-0.9'],
    ]);
    expect(usages.map((u) => u.transactionId)).toEqual(debits.map((t) => t.id));
    await expect(wallet().getBalance(account.id)).resolves.toMatchObject({
      available: '91.7354',
    });

    // The session's totals, summed exactly.
    const summary = dataOf<{
      usages: unknown[];
      totals: Record<string, unknown>;
      credits: Record<string, unknown>;
    }>(
      await as(
        account,
        http().get(`/v1/sessions/${sessionId}/ai-usage`),
      ).expect(200),
    );
    expect(summary.usages).toHaveLength(4);
    expect(summary.totals).toEqual({
      requests: 4,
      inputTokens: 4000,
      outputTokens: 1000,
      totalTokens: 5000,
      costUsd: '0.041323',
      creditsCharged: '8.2646',
      overageCredits: '0',
      uncollectedCredits: '0',
    });
    // Initialized with one reserved credit, used up by the first charge.
    expect(summary.credits).toMatchObject({
      reservedCredits: '1',
      reservationRemaining: '0',
      overageLimit: '5',
      overageUsed: '0',
    });
    // Another user cannot read it.
    const stranger = await customer('1');
    await as(stranger, http().get(`/v1/sessions/${sessionId}/ai-usage`)).expect(
      404,
    );
    await expectConsistentLedger(ctx.client, account.id);
  });

  it('rounds deductions up to the deduction step an administrator configured', async () => {
    const account = await customer('100');
    const { stepId } = await sessionWithGuide(account); // 5 + 2.34 credits
    const admin = account.id;
    // Tenths of a credit instead of the exact default.
    await settings().updateSettings(
      { deductionStepMicroCredits: 100_000 },
      { actionedBy: admin },
    );
    try {
      openRouter.plan('musecue_guide_question', { cost: 0.0231 });
      const run = await ask(account, stepId, 'stepped');
      await finished(account, run.id);
    } finally {
      await settings().updateSettings(
        { deductionStepMicroCredits: 1 },
        { actionedBy: admin },
      );
    }

    const [usage] = await ctx.client.aiUsage.findMany({
      where: { authId: account.id, operation: 'GUIDE_QUESTION' },
    });
    expect(usage.creditsExact?.toFixed()).toBe('4.62');
    expect(usage.creditsDue?.toFixed()).toBe('4.7');
    expect(usage.creditsCharged?.toFixed()).toBe('4.7');
    // 100 - 5 (analysis) - 2.34 (guide) - 4.7
    await expect(wallet().getBalance(account.id)).resolves.toMatchObject({
      available: '87.96',
    });
  });

  it('tracks retried requests but charges the run once', async () => {
    const account = await customer('100');
    const { stepId } = await sessionWithGuide(account);
    // The first attempt is billed but unusable, the second is not billed
    // (502); the third succeeds. The job is retried in between.
    openRouter.plan(
      'musecue_guide_question',
      { outcome: 'invalid-json', cost: 0.003 },
      { outcome: 'http-502' },
      { cost: 0.0045 },
    );
    const before = openRouter.count('musecue_guide_question');
    const run = await ask(account, stepId, 'retried');
    expect(await finished(account, run.id)).toMatchObject({
      status: 'COMPLETED',
    });

    expect(openRouter.count('musecue_guide_question') - before).toBe(3);
    expect(
      (await usagesOfRun(run.id)).map((u) => [
        u.outcome,
        u.errorCode,
        u.costUsd?.toFixed(),
        u.chargeStatus,
        u.chargeNote,
      ]),
    ).toEqual([
      ['FAILED', 'AI_INVALID_JSON', '0.003', 'NOT_CHARGED', 'FAILED_ATTEMPT'],
      ['SUCCEEDED', null, '0.0045', 'CHARGED', null],
    ]);
    const debits = (await debitsOf(account.id)).filter(
      (t) => t.idempotencyKey === `debit:ai-run:${run.id}`,
    );
    expect(debits.map((t) => t.amount.toFixed())).toEqual(['-0.9']);
  });

  it('never charges again for duplicated requests or repeated charging of a run', async () => {
    const account = await customer('100');
    const { stepId, sessionId } = await sessionWithGuide(account);
    const before = openRouter.count();

    const first = await ask(account, stepId, 'same-key');
    const again = await ask(account, stepId, 'same-key');
    expect(again.id).toBe(first.id);
    await finished(account, first.id);
    expect(openRouter.count() - before).toBe(1);

    // Charging the run's usage again, or a second usage of the same run (a
    // duplicate execution), adds nothing.
    const [usage] = await usagesOfRun(first.id);
    const usageService = ctx.get<CreditUsageService>(CreditUsageService);
    await ctx.client.$transaction((tx) => usageService.chargeRun(tx, usage.id));
    const duplicate = await usageService.record({
      authId: account.id,
      sessionId,
      runId: first.id,
      operation: 'GUIDE_QUESTION',
      provider: 'openrouter',
      model: MODEL,
      providerRequestId: `gen-duplicate-${first.id}`,
      outcome: 'SUCCEEDED',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: '0.0045',
      occurredAt: new Date(),
    });
    await expect(
      ctx.client.$transaction((tx) => usageService.chargeRun(tx, duplicate.id)),
    ).resolves.toMatchObject({
      status: 'NOT_CHARGED',
      note: 'RUN_ALREADY_CHARGED',
    });
    // The same generation recorded twice is one usage.
    await expect(
      usageService.record({
        authId: account.id,
        sessionId,
        runId: first.id,
        operation: 'GUIDE_QUESTION',
        provider: 'openrouter',
        model: MODEL,
        providerRequestId: usage.providerRequestId as string,
        outcome: 'SUCCEEDED',
        occurredAt: new Date(),
      }),
    ).resolves.toMatchObject({ id: usage.id });

    const debits = (await debitsOf(account.id)).filter(
      (t) => t.idempotencyKey === `debit:ai-run:${first.id}`,
    );
    expect(debits).toHaveLength(1);
    await expect(
      ctx.client.aiUsage.count({ where: { runId: first.id } }),
    ).resolves.toBe(2);
    await expectConsistentLedger(ctx.client, account.id);
  });

  it('keeps deductions exact when many AI requests of a user are processed in parallel', async () => {
    const account = await customer('30');
    const { stepId } = await sessionWithGuide(account); // 5 + 2.34 credits
    try {
      openRouter.costs.musecue_guide_question = 0.0071; // 1.42 credits
      const runs = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          ask(account, stepId, `parallel-${i}`),
        ),
      );
      const results = await Promise.all(
        runs.map((run) => finished(account, run.id)),
      );
      expect(results.every((r) => r.status === 'COMPLETED')).toBe(true);
    } finally {
      openRouter.costs.musecue_guide_question = 0.0045;
    }

    const charged = await ctx.client.aiUsage.aggregate({
      where: { authId: account.id, operation: 'GUIDE_QUESTION' },
      _sum: { creditsCharged: true, costUsd: true },
      _count: { _all: true },
    });
    expect(charged._count._all).toBe(10);
    expect(charged._sum.creditsCharged?.toFixed()).toBe('14.2');
    expect(charged._sum.costUsd?.toFixed()).toBe('0.071');
    // 30 - 5 - 2.34 - 14.2, to the micro-credit.
    await expect(wallet().getBalance(account.id)).resolves.toMatchObject({
      available: '8.46',
    });
    await expectConsistentLedger(ctx.client, account.id);
  });

  it('collects what the user can pay, then refuses further AI requests without calling OpenRouter', async () => {
    const account = await customer('10');
    const { stepId, sessionId } = await sessionWithGuide(account); // 7.34 credits
    // 0.05 USD = 10 credits: the remaining 2.66 from the balance, then the
    // session's 5 overage credits; 2.34 cannot be collected.
    openRouter.plan('musecue_guide_question', { cost: 0.05 });
    const costly = await ask(account, stepId, 'costly');
    expect(await finished(account, costly.id)).toMatchObject({
      status: 'COMPLETED',
    });
    const [usage] = await usagesOfRun(costly.id);
    expect(usage).toMatchObject({
      chargeStatus: 'UNCOLLECTED',
      chargeNote: 'INSUFFICIENT_CREDITS',
    });
    expect(usage.creditsDue?.toFixed()).toBe('10');
    expect(usage.creditsCharged?.toFixed()).toBe('7.66');
    const [debit] = (await debitsOf(account.id)).filter(
      (t) => t.idempotencyKey === `debit:ai-run:${costly.id}`,
    );
    expect([
      debit.amount.toFixed(),
      debit.overageAmount.toFixed(),
      debit.balanceAfter.toFixed(),
    ]).toEqual(['-2.66', '5', '0']);
    const summary = dataOf<{ totals: Record<string, unknown> }>(
      await as(
        account,
        http().get(`/v1/sessions/${sessionId}/ai-usage`),
      ).expect(200),
    );
    expect(summary.totals).toMatchObject({
      overageCredits: '5',
      uncollectedCredits: '2.34',
    });

    // Nothing is queued and OpenRouter is not called any more.
    const before = openRouter.count();
    const refused = await as(
      account,
      http().post(`/v1/guide-steps/${stepId}/questions`),
    )
      .set('Idempotency-Key', 'refused')
      .send({ question: 'And now?' })
      .expect(403);
    expect(refused.body).toMatchObject({ message: 'Insufficient credits' });
    expect(openRouter.count()).toBe(before);
    await expect(
      ctx.client.aiRun.count({
        where: { sessionId, idempotencyKey: 'refused' },
      }),
    ).resolves.toBe(0);
    await expect(
      ctx.client.creditSessionOverage.findFirst({ where: { sessionId } }),
    ).resolves.toMatchObject({ overageUsed: D(5) });
  });
});
