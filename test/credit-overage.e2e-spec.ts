// Must be first: PostgreSQL-only infrastructure (no Redis) and local storage,
// set before any application module reads the environment.
import './support/env-postgres-mode';
import { Prisma, userRole, userStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import { MakeupCreditService } from '../src/makeup/makeup-credit.service';
import {
  expectConsistentLedger,
  givenCreditsInPostgres,
} from './support/credit-fixtures';
import {
  FakeOpenRouter,
  MODEL,
  type FakePlan,
} from './support/fake-openrouter';
import {
  bootApplication,
  eventually,
  photo,
  type TestApplication,
} from './support/infrastructure-flows';
import {
  applyMigrations,
  connectToSchema,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import {
  retryCreditRequest,
  settledFailures,
} from './support/retry-credit-request';

jest.setTimeout(240_000);

const D = (value: string | number) => new Prisma.Decimal(value);
const PASSWORD = 'credit overage e2e password';
/** $0.005 per credit (the default rate): USD for `credits` credits. */
const usd = (credits: number) => Number((credits * 0.005).toFixed(10));

interface Envelope<T> {
  data: T;
  message?: string;
}
const dataOf = <T>(response: { body: unknown }) =>
  (response.body as Envelope<T>).data;

interface Account {
  id: string;
  auth: string;
  ip: string;
}

interface SessionCredits {
  reservedCredits: string;
  reservationRemaining: string;
  overageLimit: string;
  overageUsed: string;
  overageRemaining: string;
}

/**
 * Session credit overage and concurrency control through the complete
 * application (AppModule, HTTP, job workers, live AI gateway and OpenRouter
 * provider) against a migrated PostgreSQL schema. OpenRouter is a local
 * fake (test/support/fake-openrouter.ts) whose reported `usage.cost` drives
 * the deductions; nothing else external is contacted (REDIS_ENABLED=false,
 * local storage, captured emails, no Stripe key). Credits are set up in
 * PostgreSQL; all amounts are checked in the stored rows.
 */
describeWithDatabase('Session credit overage and concurrency (e2e)', () => {
  const openRouter = new FakeOpenRouter();
  let ctx: TestApplication;
  let ipCounter = 0;

  const http = () => request(ctx.app.getHttpServer());
  const wallet = () => ctx.get<CreditWalletService>(CreditWalletService);
  const makeupCredits = () => ctx.get<MakeupCreditService>(MakeupCreditService);

  /** A verified account (with purchased credits), signed in over HTTP. */
  const signIn = async (
    credits: string,
    role: userRole = userRole.USER,
  ): Promise<Account> => {
    const tag = randomBytes(5).toString('hex');
    const email = `overage_${tag}@example.com`;
    const user = await ctx.client.authUser.create({
      data: {
        email,
        username: `overage_${tag}`,
        password: await bcrypt.hash(PASSWORD, 4),
        verified: true,
        status: userStatus.ACTIVE,
        role,
      },
    });
    if (credits !== '0') {
      await givenCreditsInPostgres(ctx.client, user.id, 'PURCHASE', credits);
    }
    ipCounter += 1;
    const ip = `10.88.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
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

  const createSession = (account: Account) =>
    as(account, http().post('/v1/sessions'));
  const newSession = async (account: Account) =>
    dataOf<{ id: string }>(await createSession(account).expect(201)).id;

  /** Waits for a run to finish (polling PostgreSQL), then reads it over HTTP. */
  const finished = async (account: Account, runId: string) => {
    await eventually(
      async () => {
        const run = await retryCreditRequest(
          () =>
            ctx.client.aiRun.findUnique({
              where: { id: runId },
              select: { status: true },
            }),
          `poll AI run ${runId}`,
        );
        return run && ['COMPLETED', 'FAILED'].includes(run.status);
      },
      90_000,
      `AI run ${runId}`,
    );
    return dataOf<{ status: string; error: string | null }>(
      await retryCreditRequest(
        () => as(account, http().get(`/v1/jobs/${runId}`)).expect(200),
        `read AI run ${runId}`,
      ),
    );
  };

  /** Uploads the face photo and saves preferences (no AI, no credits). */
  const prepare = async (account: Account, sessionId: string) => {
    await as(account, http().post(`/v1/sessions/${sessionId}/images`))
      .field('purpose', 'INITIAL_ANALYSIS')
      .attach('image', await photo(), {
        filename: 'face.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    await as(account, http().patch(`/v1/sessions/${sessionId}/preferences`))
      .send({ vibe: 'natural', timeMinutes: 10 })
      .expect(200);
  };
  const requestAnalysis = (account: Account, sessionId: string) =>
    as(account, http().post(`/v1/sessions/${sessionId}/analyze`)).set(
      'Idempotency-Key',
      `analysis-${sessionId}`,
    );
  /** Analysis whose OpenRouter request costs `plan.cost`; waits for it. */
  const analyze = async (
    account: Account,
    sessionId: string,
    plan: FakePlan,
  ) => {
    openRouter.plan('musecue_personalization', plan);
    const run = dataOf<{ id: string }>(
      await requestAnalysis(account, sessionId).expect(201),
    );
    return { runId: run.id, ...(await finished(account, run.id)) };
  };
  /** Selects the first recommendation (queues the guide); expects `status`. */
  const requestGuide = async (
    account: Account,
    sessionId: string,
    status: number,
  ) => {
    const ready = dataOf<{ recommendations: Array<{ id: string }> }>(
      await as(account, http().get(`/v1/sessions/${sessionId}`)).expect(200),
    );
    return as(
      account,
      http().post(
        `/v1/sessions/${sessionId}/recommendations/${ready.recommendations[0].id}/select`,
      ),
    )
      .set('Idempotency-Key', `guide-${sessionId}`)
      .expect(status);
  };
  /** Guide generation costing `plan.cost`; returns the guide's step IDs. */
  const generateGuide = async (
    account: Account,
    sessionId: string,
    plan: FakePlan,
  ) => {
    openRouter.plan('musecue_guide', plan);
    const run = dataOf<{ id: string }>(
      await requestGuide(account, sessionId, 201),
    );
    expect(await finished(account, run.id)).toMatchObject({
      status: 'COMPLETED',
    });
    const session = dataOf<{
      guide: { steps: Array<{ id: string; position: number }> };
    }>(await as(account, http().get(`/v1/sessions/${sessionId}`)).expect(200));
    return [...session.guide.steps]
      .sort((a, b) => a.position - b.position)
      .map((step) => step.id);
  };
  const requestQuestion = (account: Account, stepId: string, key: string) =>
    as(account, http().post(`/v1/guide-steps/${stepId}/questions`))
      .set('Idempotency-Key', key)
      .send({ question: 'How much blush should I use?' });
  /** A question costing `plan.cost`; waits for its run. */
  const ask = async (
    account: Account,
    stepId: string,
    key: string,
    plan: FakePlan,
  ) => {
    openRouter.plan('musecue_guide_question', plan);
    const run = dataOf<{ id: string }>(
      await requestQuestion(account, stepId, key).expect(201),
    );
    return { runId: run.id, ...(await finished(account, run.id)) };
  };

  /** A session with a guide whose analysis and guide cost nothing. */
  const sessionWithFreeGuide = async (account: Account) => {
    const sessionId = await newSession(account);
    await prepare(account, sessionId);
    await analyze(account, sessionId, { cost: 0 });
    const steps = await generateGuide(account, sessionId, { cost: 0 });
    return { sessionId, steps };
  };

  const sessionCredits = async (account: Account, sessionId: string) =>
    dataOf<{
      totals: Record<string, unknown>;
      credits: SessionCredits;
    }>(
      await as(
        account,
        http().get(`/v1/sessions/${sessionId}/ai-usage`),
      ).expect(200),
    );
  const storedSessionCredits = (sessionId: string) =>
    ctx.client.creditSessionOverage.findFirstOrThrow({ where: { sessionId } });
  const debitsOf = (authId: string, sessionId?: string) =>
    ctx.client.creditTransaction.findMany({
      where: { authId, type: 'DEBIT', ...(sessionId ? { sessionId } : {}) },
      orderBy: { sequence: 'asc' },
    });
  const sum = (values: Prisma.Decimal[]) =>
    values.reduce((total, value) => total.plus(value), D(0)).toFixed();
  /**
   * The user's ledger re-checked from the stored rows (balances continue,
   * entries add up, never negative), and every session's recorded overage
   * equal to the overage of its debits.
   */
  const expectConsistentCredits = async (authId: string) => {
    const { transactions } = await expectConsistentLedger(ctx.client, authId);
    expect(transactions.every((t) => t.balanceAfter.gte(0))).toBe(true);
    const allocations = await ctx.client.creditAllocation.findMany({
      where: { authId },
    });
    expect(allocations.every((a) => a.remaining.gte(0))).toBe(true);
    const sessions = await ctx.client.creditSessionOverage.findMany({
      where: { authId },
    });
    for (const session of sessions) {
      expect(session.overageUsed.lte(session.overageLimit)).toBe(true);
      expect(session.overageUsed.toFixed()).toBe(
        sum(
          transactions
            .filter((t) => t.sessionId === session.sessionId)
            .map((t) => t.overageAmount),
        ),
      );
    }
    return { transactions, sessions };
  };

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
    expect(openRouter.handlerErrors).toEqual([]);
  });

  // Responses planned for requests that were refused are not carried over.
  beforeEach(() => openRouter.clearPlans());

  describe('session overage', () => {
    it('completes a session initialized with one credit although its OpenRouter usage surpasses the balance: the credit is deducted and the rest recorded as overage, never as a negative balance', async () => {
      const account = await signIn('1');
      const sessionId = await newSession(account);

      // Initialized with the one credit: reserved for it, overage limit 5.
      await expect(storedSessionCredits(sessionId)).resolves.toMatchObject({
        authId: account.id,
        reservedCredits: D(1),
        reservationRemaining: D(1),
        overageLimit: D(5),
        overageUsed: D(0),
      });

      await prepare(account, sessionId);
      // 0.5 + 2 + 2.5 = 5 credits used: 1 deducted, 4 as overage.
      const analysis = await analyze(account, sessionId, { cost: usd(0.5) });
      const steps = await generateGuide(account, sessionId, { cost: usd(2) });
      const first = await ask(account, steps[0], 'q1', { cost: usd(2.5) });
      expect([analysis.status, first.status]).toEqual([
        'COMPLETED',
        'COMPLETED',
      ]);

      let debits = await debitsOf(account.id, sessionId);
      expect(
        debits.map((t) => [
          t.amount.toFixed(),
          t.overageAmount.toFixed(),
          t.balanceAfter.toFixed(),
        ]),
      ).toEqual([
        ['-0.5', '0', '0.5'],
        ['-0.5', '1.5', '0'],
        ['0', '2.5', '0'],
      ]);
      await expect(storedSessionCredits(sessionId)).resolves.toMatchObject({
        overageUsed: D(4),
        reservationRemaining: D(0),
      });

      // One more credit: 6 used in total, 1 deducted and 5 as overage.
      const second = await ask(account, steps[0], 'q2', { cost: usd(1) });
      expect(second.status).toBe('COMPLETED');
      debits = await debitsOf(account.id, sessionId);
      expect(sum(debits.map((t) => t.amount))).toBe('-1');
      expect(sum(debits.map((t) => t.overageAmount))).toBe('5');
      await expect(wallet().getBalance(account.id)).resolves.toMatchObject({
        available: '0',
      });
      const usage = await sessionCredits(account, sessionId);
      expect(usage.totals).toMatchObject({
        requests: 4,
        creditsCharged: '6',
        overageCredits: '5',
      });
      expect(usage.credits).toMatchObject({
        overageLimit: '5',
        overageUsed: '5',
        overageRemaining: '0',
      });
      // Every AI request was charged in full.
      await expect(
        ctx.client.aiUsage.count({
          where: { sessionId, chargeStatus: 'CHARGED' },
        }),
      ).resolves.toBe(4);

      // The allowance is used up: further AI requests are refused before
      // anything is queued or sent to OpenRouter...
      const calls = openRouter.count();
      const refused = await requestQuestion(account, steps[0], 'q3').expect(
        403,
      );
      expect(refused.body).toMatchObject({ message: 'Insufficient credits' });
      expect(openRouter.count()).toBe(calls);
      // ...but the session itself can still be completed.
      for (const stepId of steps) {
        await as(account, http().post(`/v1/guide-steps/${stepId}/complete`))
          .send({})
          .expect(201);
      }
      const completed = dataOf<{ status: string }>(
        await as(account, http().get(`/v1/sessions/${sessionId}`)).expect(200),
      );
      expect(completed.status).toBe('COMPLETED');

      await expectConsistentCredits(account.id);
    });

    it('refuses every subsequent session without available credits with 403 "Insufficient credits"', async () => {
      const account = await signIn('1');
      const sessionId = await newSession(account);
      await prepare(account, sessionId);
      await analyze(account, sessionId, { cost: usd(3) }); // 1 + 2 overage

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await createSession(account).expect(403);
        expect(response.body).toMatchObject({
          success: false,
          statusCode: 403,
          message: 'Insufficient credits',
        });
      }
      await expect(
        ctx.client.makeupSession.count({ where: { authId: account.id } }),
      ).resolves.toBe(1);
      await expect(
        ctx.client.creditSessionOverage.count({
          where: { authId: account.id },
        }),
      ).resolves.toBe(1);

      // New credits make sessions possible again; overage is not repaid.
      await givenCreditsInPostgres(ctx.client, account.id, 'PURCHASE', '2');
      const next = await newSession(account);
      await expect(storedSessionCredits(next)).resolves.toMatchObject({
        reservedCredits: D(1),
        overageUsed: D(0),
      });
      await expect(wallet().getBalance(account.id)).resolves.toMatchObject({
        available: '2',
      });
      await expectConsistentCredits(account.id);
    });

    it('uses the overage allowance the administrator configured when the session was initialized', async () => {
      const admin = await signIn('0', userRole.ADMIN);
      const setOverage = (sessionOverageCredits: number) =>
        as(admin, http().patch('/v1/admin/credit-settings'))
          .send({ sessionOverageCredits })
          .expect(200);
      const account = await signIn('1');

      await setOverage(2);
      let sessionId: string;
      try {
        sessionId = await newSession(account);
      } finally {
        await setOverage(5);
      }
      await prepare(account, sessionId);

      // 5 credits: 1 deducted, 2 of overage (this session's limit, although
      // the setting is 5 again), 2 cannot be collected.
      await analyze(account, sessionId, { cost: usd(5) });
      const [usage] = await ctx.client.aiUsage.findMany({
        where: { sessionId },
      });
      expect(usage).toMatchObject({
        chargeStatus: 'UNCOLLECTED',
        chargeNote: 'INSUFFICIENT_CREDITS',
      });
      expect([
        usage.creditsDue?.toFixed(),
        usage.creditsCharged?.toFixed(),
      ]).toEqual(['5', '3']);
      await expect(storedSessionCredits(sessionId)).resolves.toMatchObject({
        overageLimit: D(2),
        overageUsed: D(2),
      });
      const refused = await requestGuide(account, sessionId, 403);
      expect(refused.body).toMatchObject({ message: 'Insufficient credits' });
      await expect(wallet().getBalance(account.id)).resolves.toMatchObject({
        available: '0',
      });
      await expectConsistentCredits(account.id);
    });
  });

  describe('concurrency control', () => {
    it('lets one credit initialize only one session when sessions are requested concurrently', async () => {
      const one = await signIn('1');
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => createSession(one)),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([
        201, 403, 403, 403, 403, 403,
      ]);
      expect(
        responses
          .filter((r) => r.status === 403)
          .every(
            (r) =>
              (r.body as Envelope<unknown>).message === 'Insufficient credits',
          ),
      ).toBe(true);
      await expect(
        ctx.client.makeupSession.count({ where: { authId: one.id } }),
      ).resolves.toBe(1);

      // 2.5 credits initialize three sessions (1 + 1 + 0.5), no more.
      const more = await signIn('2.5');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => createSession(more)),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      expect(results.filter((r) => r.status === 403)).toHaveLength(3);
      const reserved = await ctx.client.creditSessionOverage.findMany({
        where: { authId: more.id },
      });
      expect(reserved.map((r) => r.reservedCredits.toFixed()).sort()).toEqual([
        '0.5',
        '1',
        '1',
      ]);
      await expect(
        ctx.client.makeupSession.count({ where: { authId: more.id } }),
      ).resolves.toBe(3);
    });

    it('gives each initialized session its own credit and overage, with no double spend or overage bypass when sessions run concurrently', async () => {
      const account = await signIn('2');
      const first = await newSession(account);
      const second = await newSession(account);
      await createSession(account).expect(403);
      await prepare(account, first);
      await prepare(account, second);

      // Both analyses at once, 7 credits each: every session pays its own
      // credit and 5 overage; 1 credit each cannot be collected.
      openRouter.plan(
        'musecue_personalization',
        { cost: usd(7), delayMs: 300 },
        { cost: usd(7), delayMs: 300 },
      );
      const runs = await Promise.all(
        [first, second].map(async (sessionId) =>
          dataOf<{ id: string }>(
            await requestAnalysis(account, sessionId).expect(201),
          ),
        ),
      );
      await Promise.all(runs.map((run) => finished(account, run.id)));

      for (const sessionId of [first, second]) {
        const debits = await debitsOf(account.id, sessionId);
        expect(
          debits.map((t) => [t.amount.toFixed(), t.overageAmount.toFixed()]),
        ).toEqual([['-1', '5']]);
        await expect(storedSessionCredits(sessionId)).resolves.toMatchObject({
          overageLimit: D(5),
          overageUsed: D(5),
        });
      }
      await expect(wallet().getBalance(account.id)).resolves.toMatchObject({
        available: '0',
      });

      // A session that was never initialized (created before credits
      // existed) gets no overage: refused while the user has no free credits.
      const legacy = await ctx.client.makeupSession.create({
        data: { authId: account.id },
      });
      await prepare(account, legacy.id);
      const calls = openRouter.count();
      await requestAnalysis(account, legacy.id).expect(403);
      expect(openRouter.count()).toBe(calls);
      await expect(
        ctx.client.creditSessionOverage.count({
          where: { sessionId: legacy.id },
        }),
      ).resolves.toBe(0);
      await expectConsistentCredits(account.id);
    });

    it('keeps deductions and the overage exact when many AI requests of a session run in parallel', async () => {
      const account = await signIn('1');
      const { sessionId, steps } = await sessionWithFreeGuide(account);
      const before = openRouter.count('musecue_guide_question');

      // 10 questions of 0.7 credits (7 in total) for 1 credit and 5 overage.
      for (let i = 0; i < 10; i += 1) {
        openRouter.plan('musecue_guide_question', {
          cost: usd(0.7),
          delayMs: 200,
        });
      }
      const submitted = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => {
          const key = `parallel-${i}`;
          return retryCreditRequest(
            () => requestQuestion(account, steps[0], key),
            `question ${key}`,
          );
        }),
      );
      const queued = submitted.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      // Queued while the session could still pay; refused (403) otherwise.
      const runIds = queued
        .filter((r) => r.status === 201)
        .map((r) => dataOf<{ id: string }>(r).id);
      const completed = await Promise.allSettled(
        runIds.map((runId) => finished(account, runId)),
      );
      // A rejected HTTP request must not leave its siblings running into the
      // next test, where the fake's response plans are cleared.
      expect(settledFailures(submitted, 'submission')).toEqual([]);
      expect(settledFailures(completed, 'completion')).toEqual([]);
      expect(queued.every((r) => [201, 403].includes(r.status))).toBe(true);
      const results = completed.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      // A run either completed (and was charged as far as possible) or was
      // refused before calling OpenRouter.
      for (const result of results) {
        expect(
          result.status === 'COMPLETED' ||
            result.error === 'Insufficient credits',
        ).toBe(true);
      }

      const usages = await ctx.client.aiUsage.findMany({
        where: { sessionId, operation: 'GUIDE_QUESTION' },
      });
      // Every OpenRouter request is tracked, none without a completed run.
      expect(usages).toHaveLength(
        openRouter.count('musecue_guide_question') - before,
      );
      expect(usages).toHaveLength(
        results.filter((r) => r.status === 'COMPLETED').length,
      );
      // Exactly the credit and the overage were collected: 6 of 7 credits.
      expect(sum(usages.map((u) => u.creditsCharged ?? D(0)))).toBe('6');
      expect(
        usages.every((u) =>
          ['CHARGED', 'UNCOLLECTED'].includes(u.chargeStatus),
        ),
      ).toBe(true);
      const debits = await debitsOf(account.id, sessionId);
      expect(sum(debits.map((t) => t.amount))).toBe('-1');
      expect(sum(debits.map((t) => t.overageAmount))).toBe('5');
      await expect(storedSessionCredits(sessionId)).resolves.toMatchObject({
        overageUsed: D(5),
      });
      await expectConsistentCredits(account.id);
    });

    it('applies concurrent charges of several sessions one at a time, each exactly once', async () => {
      const account = await signIn('2');
      const sessions = [await newSession(account), await newSession(account)];
      const credits = makeupCredits();
      const sources = await credits.usableSources(account.id);
      // 15 requests of 0.5 credits per session, all charged at once, each
      // in its own transaction (as when results are published).
      const usages = await Promise.all(
        sessions.flatMap((sessionId) =>
          Array.from({ length: 15 }, async () => {
            const runId = randomUUID();
            return credits.recordUsage(
              { runId, authId: account.id, sessionId },
              'GUIDE_QUESTION',
              'openrouter',
              {
                responseId: `gen-${runId}`,
                model: MODEL,
                usage: {
                  promptTokens: 100,
                  completionTokens: 20,
                  totalTokens: 120,
                  costUsd: String(usd(0.5)),
                },
              },
            );
          }),
        ),
      );
      const charges = await Promise.all(
        usages.map((usage) =>
          ctx.client.$transaction(
            (tx) => credits.chargeRun(tx, usage!, sources),
            { maxWait: 30_000, timeout: 30_000 },
          ),
        ),
      );

      for (const sessionId of sessions) {
        const charged = await ctx.client.aiUsage.findMany({
          where: { sessionId },
        });
        // 1 credit of its own and 5 overage: 12 charges, 3 not collected.
        expect(
          charged.filter((u) => u.chargeStatus === 'CHARGED'),
        ).toHaveLength(12);
        expect(
          charged.filter((u) => u.chargeStatus === 'UNCOLLECTED'),
        ).toHaveLength(3);
        const debits = await debitsOf(account.id, sessionId);
        expect(debits).toHaveLength(12);
        expect(sum(debits.map((t) => t.amount))).toBe('-1');
        expect(sum(debits.map((t) => t.overageAmount))).toBe('5');
      }
      expect(charges.filter((c) => c.status === 'CHARGED')).toHaveLength(24);

      // Charging the same run again, concurrently and with duplicate
      // executions of it, adds nothing.
      const [sessionId] = sessions;
      const runId = randomUUID();
      const duplicates = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          credits.recordUsage(
            { runId, authId: account.id, sessionId },
            'GUIDE_QUESTION',
            'openrouter',
            {
              responseId: `gen-${runId}-${i}`,
              model: MODEL,
              usage: { costUsd: '0' },
            },
          ),
        ),
      );
      await Promise.all(
        [...duplicates, ...duplicates].map((usage) =>
          ctx.client.$transaction(
            (tx) => credits.chargeRun(tx, usage!, sources),
            { maxWait: 30_000, timeout: 30_000 },
          ),
        ),
      );
      await expect(
        ctx.client.creditTransaction.count({
          where: {
            authId: account.id,
            idempotencyKey: `debit:ai-run:${runId}`,
          },
        }),
      ).resolves.toBe(0);
      await expect(
        ctx.client.aiUsage.count({
          where: { runId, chargeStatus: 'PENDING' },
        }),
      ).resolves.toBe(0);
      await expectConsistentCredits(account.id);
    });
  });

  describe('interrupted and unsuccessful OpenRouter requests', () => {
    it('charges a retried run once, with its overage recorded once', async () => {
      const account = await signIn('1');
      const { sessionId, steps } = await sessionWithFreeGuide(account);
      await ask(account, steps[0], 'use-the-credit', { cost: usd(1) });

      // Not billed (502), then billed but unusable, then successful: the
      // job is retried in between; 2 credits are due, all of it overage.
      openRouter.plan(
        'musecue_guide_question',
        { outcome: 'http-502' },
        { outcome: 'invalid-json', cost: usd(3) },
      );
      const run = await ask(account, steps[0], 'retried', { cost: usd(2) });
      expect(run.status).toBe('COMPLETED');

      const usages = await ctx.client.aiUsage.findMany({
        where: { runId: run.runId },
        orderBy: { occurredAt: 'asc' },
      });
      expect(
        usages.map((u) => [
          u.outcome,
          u.costUsd?.toFixed(),
          u.chargeStatus,
          u.chargeNote,
          u.creditsCharged?.toFixed() ?? null,
        ]),
      ).toEqual([
        ['FAILED', '0.015', 'NOT_CHARGED', 'FAILED_ATTEMPT', null],
        ['SUCCEEDED', '0.01', 'CHARGED', null, '2'],
      ]);
      const debits = await ctx.client.creditTransaction.findMany({
        where: { idempotencyKey: `debit:ai-run:${run.runId}` },
      });
      expect(
        debits.map((t) => [t.amount.toFixed(), t.overageAmount.toFixed()]),
      ).toEqual([['0', '2']]);
      await expect(storedSessionCredits(sessionId)).resolves.toMatchObject({
        overageUsed: D(2),
      });
      await expectConsistentCredits(account.id);
    });

    it('settles usage left by an interrupted attempt without charging it, whether its run is then published or fails', async () => {
      const account = await signIn('1');
      const { sessionId, steps } = await sessionWithFreeGuide(account);
      await ask(account, steps[0], 'use-the-credit', { cost: usd(1) });
      const credits = makeupCredits();
      /**
       * While the run's request waits for OpenRouter, records what an
       * earlier attempt of the run left behind when its worker stopped
       * after OpenRouter answered (its usage, still pending).
       */
      const interruptedAttempt = async (runId: string, calls: number) => {
        await eventually(
          () =>
            Promise.resolve(openRouter.count('musecue_guide_question') > calls),
          30_000,
          'the request to reach OpenRouter',
        );
        return credits.recordUsage(
          { runId, authId: account.id, sessionId },
          'GUIDE_QUESTION',
          'openrouter',
          {
            responseId: `gen-interrupted-${runId}`,
            model: MODEL,
            usage: { totalTokens: 900, costUsd: String(usd(4)) },
          },
        );
      };

      // The run is retried and published: charged once, for its result.
      let calls = openRouter.count('musecue_guide_question');
      openRouter.plan('musecue_guide_question', {
        cost: usd(2),
        delayMs: 1500,
      });
      const published = dataOf<{ id: string }>(
        await requestQuestion(account, steps[0], 'published').expect(201),
      );
      const leftover = await interruptedAttempt(published.id, calls);
      expect(await finished(account, published.id)).toMatchObject({
        status: 'COMPLETED',
      });
      await expect(
        ctx.client.aiUsage.findUniqueOrThrow({ where: { id: leftover!.id } }),
      ).resolves.toMatchObject({
        chargeStatus: 'NOT_CHARGED',
        chargeNote: 'SUPERSEDED_ATTEMPT',
        transactionId: null,
      });
      await expect(
        ctx.client.creditTransaction.count({
          where: { idempotencyKey: `debit:ai-run:${published.id}` },
        }),
      ).resolves.toBe(1);

      // The run fails for good: nothing is charged.
      calls = openRouter.count('musecue_guide_question');
      openRouter.plan('musecue_guide_question', {
        outcome: 'http-400',
        delayMs: 1500,
      });
      const failed = dataOf<{ id: string }>(
        await requestQuestion(account, steps[0], 'failed').expect(201),
      );
      const failedLeftover = await interruptedAttempt(failed.id, calls);
      expect(await finished(account, failed.id)).toMatchObject({
        status: 'FAILED',
      });
      await expect(
        ctx.client.aiUsage.findUniqueOrThrow({
          where: { id: failedLeftover!.id },
        }),
      ).resolves.toMatchObject({
        chargeStatus: 'NOT_CHARGED',
        chargeNote: 'RUN_FAILED',
      });
      await expect(
        ctx.client.creditTransaction.count({
          where: { idempotencyKey: `debit:ai-run:${failed.id}` },
        }),
      ).resolves.toBe(0);

      // Pending usage of a run that can no longer publish (here: a finished
      // run) is settled by the recovery sweep, once.
      const stray = await credits.recordUsage(
        { runId: published.id, authId: account.id, sessionId },
        'GUIDE_QUESTION',
        'openrouter',
        {
          responseId: `gen-stray-${published.id}`,
          model: MODEL,
          usage: { costUsd: String(usd(1)) },
        },
      );
      const cutoff = new Date(Date.now() + 1000);
      await expect(credits.settleInterruptedUsage(cutoff)).resolves.toBe(1);
      await expect(credits.settleInterruptedUsage(cutoff)).resolves.toBe(0);
      await expect(
        ctx.client.aiUsage.findUniqueOrThrow({ where: { id: stray!.id } }),
      ).resolves.toMatchObject({
        chargeStatus: 'NOT_CHARGED',
        chargeNote: 'INTERRUPTED',
      });

      // Only the published run was charged: 2 credits, all overage.
      const debits = await debitsOf(account.id, sessionId);
      expect(sum(debits.map((t) => t.amount))).toBe('-1');
      expect(sum(debits.map((t) => t.overageAmount))).toBe('2');
      await expect(storedSessionCredits(sessionId)).resolves.toMatchObject({
        overageUsed: D(2),
      });
      await expectConsistentCredits(account.id);
    });
  });

  describe('reservations', () => {
    it('releases the unused reservation of a completed session', async () => {
      const account = await signIn('1.5');
      const { sessionId, steps } = await sessionWithFreeGuide(account);
      const other = await newSession(account); // reserves the other 0.5
      await createSession(account).expect(403);

      for (const stepId of steps) {
        await as(account, http().post(`/v1/guide-steps/${stepId}/complete`))
          .send({})
          .expect(201);
      }
      await expect(sessionCredits(account, sessionId)).resolves.toMatchObject({
        credits: { reservationRemaining: '0' },
      });

      // The completed session's credit is free again.
      const next = await newSession(account);
      await expect(storedSessionCredits(next)).resolves.toMatchObject({
        reservedCredits: D(1),
      });
      await expect(storedSessionCredits(sessionId)).resolves.toMatchObject({
        reservationRemaining: D(0),
      });
      await expect(storedSessionCredits(other)).resolves.toMatchObject({
        reservationRemaining: D('0.5'),
      });
    });

    it('lets an unfinished session keep its reserved credit and overage however long it is idle', async () => {
      const account = await signIn('1');
      const idle = await newSession(account);
      await prepare(account, idle);

      // Three days without any activity.
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      await ctx.client.$executeRawUnsafe(
        `UPDATE "CreditSessionOverage" SET "updatedAt" = $1 WHERE "sessionId" = $2`,
        threeDaysAgo,
        idle,
      );
      await ctx.client.$executeRawUnsafe(
        `UPDATE "MakeupSession" SET "updatedAt" = $1 WHERE "id" = $2`,
        threeDaysAgo,
        idle,
      );

      // The credit still belongs to the unfinished session...
      await createSession(account).expect(403);
      await expect(storedSessionCredits(idle)).resolves.toMatchObject({
        reservedCredits: D(1),
        reservationRemaining: D(1),
      });
      // ...which continues beyond it with its overage (3 credits: 1 + 2).
      const analysis = await analyze(account, idle, { cost: usd(3) });
      expect(analysis.status).toBe('COMPLETED');
      await expect(storedSessionCredits(idle)).resolves.toMatchObject({
        reservationRemaining: D(0),
        overageUsed: D(2),
      });
      await expectConsistentCredits(account.id);
    });
  });

  describe('PostgreSQL rules', () => {
    it('rejects overage and reservation changes that do not match the debits', async () => {
      const account = await signIn('1');
      const sessionId = await newSession(account);
      await prepare(account, sessionId);
      await analyze(account, sessionId, { cost: usd(2) }); // 1 + 1 overage
      const row = await storedSessionCredits(sessionId);
      const attempt = (sql: string) =>
        ctx.client.$transaction((tx) => tx.$executeRawUnsafe(sql));

      await expect(
        attempt(
          `UPDATE "CreditSessionOverage" SET "overageUsed" = 6 WHERE "id" = '${row.id}'`,
        ),
      ).rejects.toThrow('CreditSessionOverage_range');
      await expect(
        attempt(
          `UPDATE "CreditSessionOverage" SET "overageUsed" = 2 WHERE "id" = '${row.id}'`,
        ),
      ).rejects.toThrow('but its debits used');
      await expect(
        attempt(
          `UPDATE "CreditSessionOverage" SET "overageUsed" = 0 WHERE "id" = '${row.id}'`,
        ),
      ).rejects.toThrow('usage can only grow');
      await expect(
        attempt(
          `UPDATE "CreditSessionOverage" SET "reservationRemaining" = 1 WHERE "id" = '${row.id}'`,
        ),
      ).rejects.toThrow('reservation can only be used up or released');
      await expect(
        attempt(
          `UPDATE "CreditSessionOverage" SET "overageLimit" = 50 WHERE "id" = '${row.id}'`,
        ),
      ).rejects.toThrow('limit cannot change');
      // Overage for a session without its record.
      const wallet = await ctx.client.creditWallet.findUniqueOrThrow({
        where: { authId: account.id },
      });
      await expect(
        attempt(
          `INSERT INTO "CreditTransaction" ("id", "walletId", "authId", "type", "amount", "overageAmount", "balanceAfter", "idempotencyKey", "sessionId", "occurredAt")
           VALUES ('${randomUUID()}', '${wallet.id}', '${account.id}', 'DEBIT', 0, 1, 0, 'forged', 'no-such-session', now())`,
        ),
      ).rejects.toThrow('without its CreditSessionOverage record');

      await expect(storedSessionCredits(sessionId)).resolves.toEqual(row);
      await expectConsistentCredits(account.id);
    });
  });
});

/**
 * The migrations of session overage, the removed idle lapse and the review
 * constraints, applied to data written by the releases before them (raw
 * SQL on a schema migrated up to that point).
 */
describeWithDatabase('Session credit migrations (PostgreSQL)', () => {
  const OVERAGE = '20261127120000_session_credit_overage';
  const NO_LAPSE = '20261128120000_remove_session_reservation_lapse';
  const REVIEW = '20261129120000_credit_review_constraints';
  const schemas: string[] = [];
  let pg: Awaited<ReturnType<typeof connectToSchema>> | undefined;

  /** A schema with the migrations before `migration` applied. */
  const schemaBefore = async (migration: string) => {
    const schema = await createSchema();
    schemas.push(schema);
    const names = migrationNames();
    await applyMigrations(schema, names.slice(0, names.indexOf(migration)));
    pg = await connectToSchema(schema);
    return schema;
  };
  /** Applies `migration` and the ones after it. */
  const migrateFrom = async (schema: string, migration: string) => {
    const names = migrationNames();
    await applyMigrations(schema, names.slice(names.indexOf(migration)));
  };
  const user = async () => {
    const id = randomUUID();
    await pg!.query(
      `INSERT INTO "authUser" ("id", "email", "password", "username", "updatedAt")
       VALUES ('${id}', '${id}@example.com', 'x', 'u_${id}', now())`,
    );
    return id;
  };
  /**
   * A wallet as an earlier release wrote it: 1 purchased credit and a
   * session debit that took it and `overage` more as session overage, with
   * the session's overage record (`recorded` overage used).
   */
  const legacySessionDebit = async (
    authId: string,
    overage: string,
    recorded: string,
  ) => {
    await pg!.query(`
      DO $$
      DECLARE w text := gen_random_uuid()::text; a text := gen_random_uuid()::text;
              g text := gen_random_uuid()::text; d text := gen_random_uuid()::text;
      BEGIN
        INSERT INTO "CreditWallet" ("id", "authId") VALUES (w, '${authId}');
        INSERT INTO "CreditAllocation" ("id", "walletId", "authId", "source", "sourceReference", "amount", "remaining", "grantedAt", "updatedAt")
        VALUES (a, w, '${authId}', 'PURCHASE', 'legacy', 1, 0, now() - interval '1 day', now());
        INSERT INTO "CreditTransaction" ("id", "walletId", "authId", "type", "amount", "balanceAfter", "idempotencyKey", "occurredAt")
        VALUES (g, w, '${authId}', 'GRANT', 1, 1, 'grant:PURCHASE:legacy', now() - interval '1 day');
        INSERT INTO "CreditLedgerEntry" ("id", "walletId", "transactionId", "allocationId", "amount")
        VALUES (gen_random_uuid()::text, w, g, a, 1);
        INSERT INTO "CreditTransaction" ("id", "walletId", "authId", "type", "amount", "overageAmount", "balanceAfter", "idempotencyKey", "sessionId", "occurredAt")
        VALUES (d, w, '${authId}', 'DEBIT', -1, ${overage}, 0, 'debit:legacy', 'legacy-session', now());
        INSERT INTO "CreditLedgerEntry" ("id", "walletId", "transactionId", "allocationId", "amount")
        VALUES (gen_random_uuid()::text, w, d, a, -1);
        INSERT INTO "CreditSessionOverage" ("id", "walletId", "authId", "sessionId", "overageLimit", "overageUsed", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, w, '${authId}', 'legacy-session', 5, ${recorded}, now() - interval '2 hours', now() - interval '1 hour');
      END $$;`);
  };
  const step = async () =>
    (
      await pg!.query<{ step: number }>(
        'SELECT "deductionStepMicroCredits" AS "step" FROM "CreditSettings"',
      )
    ).rows[0].step;

  afterEach(async () => {
    await pg?.end();
    pg = undefined;
    for (const schema of schemas.splice(0)) await dropSchema(schema);
  });

  it('makes exact deductions the default, unless an administrator chose the step', async () => {
    const untouched = await schemaBefore(OVERAGE);
    expect(await step()).toBe(1_000_000);
    await migrateFrom(untouched, OVERAGE);
    expect(await step()).toBe(1);
    await pg!.end();

    const chosen = await schemaBefore(OVERAGE);
    await pg!.query(`
      WITH e AS (
        INSERT INTO "ActivityLogEvent" ("id", "tableName", "recordId", "action")
        VALUES (gen_random_uuid()::text, 'CreditSettings', '1', 'update') RETURNING "id"
      )
      INSERT INTO "ActivityLogEventDetail" ("id", "eventId", "fieldName", "oldValue", "newValue")
      SELECT gen_random_uuid()::text, e."id", 'deductionStepMicroCredits', '100000', '1000000' FROM e`);
    await migrateFrom(chosen, OVERAGE);
    expect(await step()).toBe(1_000_000);
    // At most one credit (the API's bound), also for direct writes.
    await expect(
      pg!.query(
        'UPDATE "CreditSettings" SET "deductionStepMicroCredits" = 1000001',
      ),
    ).rejects.toThrow('CreditSettings_deductionStepMicroCredits_max');
  });

  it('keeps the overage of sessions that used it before, as initialized sessions, and holds it to their debits from then on', async () => {
    const schema = await schemaBefore(OVERAGE);
    const authId = await user();
    await legacySessionDebit(authId, '2', '2');

    await migrateFrom(schema, OVERAGE);

    const { rows } = await pg!.query<Record<string, unknown>>(
      'SELECT "overageLimit"::text, "overageUsed"::text, "reservedCredits"::text, "reservationRemaining"::text, "initializedAt" = "createdAt" AS "initializedAtCreation" FROM "CreditSessionOverage"',
    );
    expect(rows).toEqual([
      {
        overageLimit: '5.000000',
        overageUsed: '2.000000',
        reservedCredits: '0.000000',
        reservationRemaining: '0.000000',
        initializedAtCreation: true,
      },
    ]);
    await expect(
      pg!.query('UPDATE "CreditSessionOverage" SET "overageUsed" = 3'),
    ).rejects.toThrow('but its debits used');
  });

  it('refuses to migrate overage records that do not match their debits', async () => {
    const schema = await schemaBefore(OVERAGE);
    const authId = await user();
    await legacySessionDebit(authId, '2', '3');

    await expect(migrateFrom(schema, OVERAGE)).rejects.toThrow(
      'session overage records do not match their debits',
    );
  });

  it('keeps sessions that had lapsed (initialized again) when the idle lapse is removed', async () => {
    const schema = await schemaBefore(NO_LAPSE);
    const authId = await user();
    await pg!.query(`
      DO $$
      DECLARE w text := gen_random_uuid()::text;
      BEGIN
        INSERT INTO "CreditWallet" ("id", "authId") VALUES (w, '${authId}');
        INSERT INTO "CreditSessionOverage" ("id", "walletId", "authId", "sessionId", "status", "overageLimit", "reservedCredits", "reservationRemaining", "updatedAt")
        VALUES (gen_random_uuid()::text, w, '${authId}', 'lapsed', 'LAPSED', 5, 1, 0, now()),
               (gen_random_uuid()::text, w, '${authId}', 'active', 'ACTIVE', 5, 1, 1, now());
      END $$;`);

    await migrateFrom(schema, NO_LAPSE);

    const { rows } = await pg!.query<Record<string, unknown>>(
      'SELECT "sessionId", "reservationRemaining"::text FROM "CreditSessionOverage" ORDER BY "sessionId"',
    );
    expect(rows).toEqual([
      { sessionId: 'active', reservationRemaining: '1.000000' },
      { sessionId: 'lapsed', reservationRemaining: '0.000000' },
    ]);
    const columns = await pg!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'CreditSessionOverage'`,
    );
    expect(columns.rows.map((c) => c.column_name)).not.toEqual(
      expect.arrayContaining(['status']),
    );
    expect(columns.rows.map((c) => c.column_name)).not.toContain(
      'lastActivityAt',
    );
    // A reservation is only used up or released, never renewed.
    await expect(
      pg!.query(
        `UPDATE "CreditSessionOverage" SET "reservationRemaining" = 1 WHERE "sessionId" = 'lapsed'`,
      ),
    ).rejects.toThrow('reservation can only be used up or released');
  });

  it('refuses to migrate AI usage charges that do not match their debits', async () => {
    const schema = await schemaBefore(REVIEW);
    const authId = await user();
    await legacySessionDebit(authId, '0', '0');
    // A charged usage claiming 2 credits for a debit of 1.
    await pg!.query(`
      INSERT INTO "AiUsage" ("id", "authId", "sessionId", "runId", "operation", "provider", "model", "outcome",
                             "inputTokens", "outputTokens", "totalTokens", "costUsd", "chargeStatus",
                             "creditCostUsdMicros", "creditsExact", "creditsDue", "creditsCharged", "transactionId", "occurredAt", "updatedAt")
      SELECT gen_random_uuid()::text, '${authId}', 'legacy-session', 'run', 'GUIDE_QUESTION', 'openrouter', 'm', 'SUCCEEDED',
             10, 5, 15, NULL, 'CHARGED', 5000, 2, 2, 2, t."id", now(), now()
      FROM "CreditTransaction" t WHERE t."idempotencyKey" = 'debit:legacy'`);

    await expect(migrateFrom(schema, REVIEW)).rejects.toThrow(
      'AI usage charges do not match their DEBIT transactions',
    );
  });

  it('refuses an AI usage charge that does not match its DEBIT', async () => {
    const schema = await schemaBefore(REVIEW);
    const authId = await user();
    await legacySessionDebit(authId, '0', '0');
    await migrateFrom(schema, REVIEW);

    await expect(
      pg!.query(`
        INSERT INTO "AiUsage" ("id", "authId", "sessionId", "runId", "operation", "provider", "model", "outcome",
                               "inputTokens", "outputTokens", "totalTokens", "costUsd", "chargeStatus",
                               "creditCostUsdMicros", "creditsExact", "creditsDue", "creditsCharged", "transactionId", "occurredAt", "updatedAt")
        SELECT gen_random_uuid()::text, '${authId}', 'legacy-session', 'run', 'GUIDE_QUESTION', 'openrouter', 'm', 'SUCCEEDED',
               10, 5, 15, 0.005, 'CHARGED', 5000, 1, 1, 1, t."id", now(), now()
        FROM "CreditTransaction" t WHERE t."idempotencyKey" = 'debit:legacy'`),
    ).rejects.toThrow('does not match its DEBIT transaction');
  });
});
