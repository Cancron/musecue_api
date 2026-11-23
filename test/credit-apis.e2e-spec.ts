// Must be first: PostgreSQL-only infrastructure (no Redis) and local storage,
// set before any application module reads the environment.
import './support/env-postgres-mode';
import { BillingInterval, CreditSource, userStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import { addBillingInterval } from '../src/subscription/billing.validation';
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
import { describeWithDatabase } from './support/migrated-schema';
import { DAY_MS, givenPaidProHistory } from './support/subscription-fixtures';

jest.setTimeout(240_000);

const PASSWORD = 'credit apis e2e password';
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

interface SourceBalance {
  source: string;
  granted: string;
  available: string;
  upcoming: string;
  used: string;
  expired: string;
  expires: boolean;
  usableNow: boolean;
  nextExpiresAt: string | null;
}
interface AllocationBalance {
  id: string;
  source: string;
  state: string;
  granted: string;
  available: string;
  upcoming: string;
  used: string;
  expired: string;
  grantedAt: string;
  expiresAt: string | null;
  expiredAt: string | null;
}
interface Balance {
  available: string;
  usable: string;
  reserved: string;
  free: string;
  upcoming: string;
  granted: string;
  used: string;
  expired: string;
  overageUsed: string;
  nextExpiration: {
    expiresAt: string;
    amount: string;
    sources: string[];
  } | null;
  sources: SourceBalance[];
  allocations: AllocationBalance[];
}
interface HistoryItem {
  id: string;
  sequence: string;
  type: string;
  amount: string;
  overageAmount: string;
  creditsCharged: string | null;
  balanceAfter: string;
  source: string | null;
  sources: Array<{
    source: string;
    amount: string;
    allocationId: string | null;
    expiresAt: string | null;
  }>;
  occurredAt: string;
  sessionId: string | null;
  session: { id: string; status: string } | null;
  aiUsage: {
    runId: string;
    operation: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: string | null;
    creditCostUsdMicros: number | null;
    creditCostUsd: string | null;
    creditsCharged: string | null;
  } | null;
}
interface HistoryPage {
  items: HistoryItem[];
  nextCursor: string | null;
}
interface SessionUsage {
  usages: Array<{
    id: string;
    runId: string;
    operation: string;
    outcome: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: string | null;
    chargeStatus: string;
    chargeNote: string | null;
    creditCostUsdMicros: number | null;
    creditCostUsd: string | null;
    creditsDue: string | null;
    creditsCharged: string | null;
    overageCredits: string | null;
    transactionId: string | null;
  }>;
  totals: Record<string, unknown>;
  credits: Record<string, unknown> | null;
}

/**
 * The credit balance, transaction history and session AI usage APIs through
 * the complete application (AppModule, HTTP, real AuthGuard and validation,
 * job workers, live AI gateway) against a migrated PostgreSQL schema.
 * OpenRouter is a local fake (test/support/fake-openrouter.ts); credits of
 * earlier months (an expired trial and an expired subscription month) are
 * set up through the wallet with their own dates. Nothing external is
 * contacted (REDIS_ENABLED=false, local storage, no Stripe key).
 */
describeWithDatabase(
  'Credit balance and transaction history APIs (e2e)',
  () => {
    const openRouter = new FakeOpenRouter();
    let ctx: TestApplication;
    let ipCounter = 0;
    const NOW = Date.now();
    const daysAgo = (days: number) => new Date(NOW - days * DAY_MS);
    /** Alice's Pro month: one calendar month from 35 days ago (ended). */
    const aliceProStart = daysAgo(35);
    const aliceProEnd = addBillingInterval(
      aliceProStart,
      BillingInterval.MONTHLY,
    );

    const http = () => request(ctx.app.getHttpServer());
    const wallet = () => ctx.get<CreditWalletService>(CreditWalletService);

    /** A verified account, signed in over HTTP. */
    const signIn = async (): Promise<Account> => {
      const tag = randomBytes(5).toString('hex');
      const email = `apis_${tag}@example.com`;
      const user = await ctx.client.authUser.create({
        data: {
          email,
          username: `apis_${tag}`,
          password: await bcrypt.hash(PASSWORD, 4),
          verified: true,
          status: userStatus.ACTIVE,
        },
      });
      ipCounter += 1;
      const ip = `10.99.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
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

    const getBalance = async (account: Account) =>
      dataOf<Balance>(
        await as(account, http().get('/v1/credits/balance')).expect(200),
      );
    const getHistory = async (account: Account, query = '') =>
      dataOf<HistoryPage>(
        await as(
          account,
          http().get(`/v1/credits/transactions${query}`),
        ).expect(200),
      );
    const getUsage = async (account: Account, sessionId: string) =>
      dataOf<SessionUsage>(
        await as(
          account,
          http().get(`/v1/sessions/${sessionId}/ai-usage`),
        ).expect(200),
      );
    const sourceOf = (balance: Balance, source: string) =>
      balance.sources.find((s) => s.source === source) as SourceBalance;

    /** Waits for a run to finish (polling PostgreSQL). */
    const finished = async (account: Account, runId: string) => {
      await eventually(
        async () => {
          const run = await ctx.client.aiRun.findUnique({
            where: { id: runId },
            select: { status: true },
          });
          return run && ['COMPLETED', 'FAILED'].includes(run.status);
        },
        90_000,
        `AI run ${runId}`,
      );
      return dataOf<{ status: string }>(
        await as(account, http().get(`/v1/jobs/${runId}`)).expect(200),
      );
    };
    const newSession = async (account: Account) =>
      dataOf<{ id: string }>(
        await as(account, http().post('/v1/sessions')).expect(201),
      ).id;
    /** Image, preferences and analysis costing `plan.cost`. */
    const analyzed = async (
      account: Account,
      sessionId: string,
      plan: FakePlan,
    ) => {
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
      openRouter.plan('musecue_personalization', plan);
      const run = dataOf<{ id: string }>(
        await as(account, http().post(`/v1/sessions/${sessionId}/analyze`))
          .set('Idempotency-Key', `analysis-${sessionId}`)
          .expect(201),
      );
      expect(await finished(account, run.id)).toMatchObject({
        status: 'COMPLETED',
      });
      return run.id;
    };
    /** Guide generation costing `plan.cost`; returns the step IDs in order. */
    const guided = async (
      account: Account,
      sessionId: string,
      plan: FakePlan,
    ) => {
      const ready = dataOf<{ recommendations: Array<{ id: string }> }>(
        await as(account, http().get(`/v1/sessions/${sessionId}`)).expect(200),
      );
      openRouter.plan('musecue_guide', plan);
      const run = dataOf<{ id: string }>(
        await as(
          account,
          http().post(
            `/v1/sessions/${sessionId}/recommendations/${ready.recommendations[0].id}/select`,
          ),
        )
          .set('Idempotency-Key', `guide-${sessionId}`)
          .expect(201),
      );
      expect(await finished(account, run.id)).toMatchObject({
        status: 'COMPLETED',
      });
      const session = dataOf<{
        guide: { steps: Array<{ id: string; position: number }> };
      }>(
        await as(account, http().get(`/v1/sessions/${sessionId}`)).expect(200),
      );
      return {
        runId: run.id,
        steps: [...session.guide.steps]
          .sort((a, b) => a.position - b.position)
          .map((step) => step.id),
      };
    };
    const askQuestion = (account: Account, stepId: string, key: string) =>
      as(account, http().post(`/v1/guide-steps/${stepId}/questions`))
        .set('Idempotency-Key', key)
        .send({ question: 'How much blush should I use?' })
        .expect(201);

    let alice: Account;
    let carol: Account;
    let aliceSession: string;
    let carolSession: string;
    const aliceRuns: string[] = [];
    let aliceRequests = 0;

    beforeAll(async () => {
      await openRouter.start();
      process.env.AI_MODE = 'live';
      process.env.OPENROUTER_API_KEY = 'sk-or-v1-e2e-test-key';
      process.env.OPENROUTER_BASE_URL = openRouter.url;
      process.env.OPENROUTER_MODEL = MODEL;
      process.env.AI_QUEUE_RATE_LIMIT_MAX = '1000';
      ctx = await bootApplication();

      // Alice: a trial and a Pro month that have expired since (the
      // subscription too), plus purchased and referral credits, each granted
      // and partly used on its own date.
      alice = await signIn();
      await wallet().grant(
        {
          authId: alice.id,
          source: CreditSource.TRIAL,
          sourceReference: 'trial',
          amount: 50,
          expiresAt: daysAgo(33),
        },
        { at: daysAgo(40) },
      );
      await wallet().debit(
        { authId: alice.id, amount: 10, idempotencyKey: 'trial-usage' },
        { at: daysAgo(38) },
      );
      await givenPaidProHistory(
        ctx.client,
        alice.id,
        { billingInterval: BillingInterval.MONTHLY, startedAt: aliceProStart },
        new Date(NOW),
      );
      const subscription = await ctx.client.userSubscription.findUniqueOrThrow({
        where: { authId: alice.id },
        include: { payments: true },
      });
      await wallet().grant(
        {
          authId: alice.id,
          source: CreditSource.SUBSCRIPTION,
          sourceReference: 'pro-month-1',
          amount: 1000,
          expiresAt: aliceProEnd,
          payment: {
            subscriptionId: subscription.id,
            paymentId: subscription.payments[0].id,
            periodStart: subscription.payments[0].periodStart,
          },
        },
        { at: aliceProStart },
      );
      await wallet().grant(
        {
          authId: alice.id,
          source: CreditSource.PURCHASE,
          sourceReference: 'pack-30',
          amount: 30,
        },
        { at: daysAgo(30) },
      );
      await wallet().grant(
        {
          authId: alice.id,
          source: CreditSource.REFERRAL,
          sourceReference: 'friend-1',
          amount: 5,
        },
        { at: daysAgo(25) },
      );
      await wallet().debit(
        { authId: alice.id, amount: 200, idempotencyKey: 'pro-usage' },
        { at: daysAgo(20) },
      );

      // Alice's makeup session today: several OpenRouter requests, one of
      // them retried after a billed but unusable answer, one sent twice.
      const before = openRouter.count();
      aliceSession = await newSession(alice);
      aliceRuns.push(await analyzed(alice, aliceSession, { cost: usd(5) }));
      const guide = await guided(alice, aliceSession, { cost: usd(2) });
      aliceRuns.push(guide.runId);
      openRouter.plan(
        'musecue_guide_question',
        { outcome: 'invalid-json', cost: usd(0.4) },
        { cost: usd(0.5) },
      );
      const first = dataOf<{ id: string }>(
        await askQuestion(alice, guide.steps[0], 'q1'),
      );
      expect(await finished(alice, first.id)).toMatchObject({
        status: 'COMPLETED',
      });
      openRouter.plan('musecue_guide_question', { cost: usd(1.5) });
      const second = dataOf<{ id: string }>(
        await askQuestion(alice, guide.steps[0], 'q2'),
      );
      const again = dataOf<{ id: string }>(
        await askQuestion(alice, guide.steps[0], 'q2'),
      );
      expect(again.id).toBe(second.id);
      expect(await finished(alice, second.id)).toMatchObject({
        status: 'COMPLETED',
      });
      aliceRuns.push(first.id, second.id);
      aliceRequests = openRouter.count() - before;

      // Carol: one referral credit; her session goes 3 credits into overage.
      carol = await signIn();
      await givenCreditsInPostgres(ctx.client, carol.id, 'REFERRAL', '1');
      carolSession = await newSession(carol);
      await analyzed(carol, carolSession, { cost: usd(4) });
    });

    afterAll(async () => {
      await ctx?.close();
      await openRouter.stop();
      delete process.env.AI_QUEUE_RATE_LIMIT_MAX;
    });

    describe('GET /v1/credits/balance', () => {
      it('reports every source with granted, used, expired and available credits and expiry dates; expired credits never count', async () => {
        const balance = await getBalance(alice);

        // Today's session used 9: the 5 referral credits first (spent
        // before purchased credits, though granted later), then 4 of the
        // 30 purchased.
        expect(balance).toMatchObject({
          available: '26',
          usable: '26',
          upcoming: '0',
          granted: '1085',
          used: '219',
          expired: '840',
          overageUsed: '0',
          nextExpiration: null,
        });
        expect(balance.sources).toEqual([
          {
            source: 'TRIAL',
            granted: '50',
            available: '0',
            upcoming: '0',
            used: '10',
            expired: '40',
            expires: true,
            usableNow: false,
            nextExpiresAt: null,
          },
          {
            source: 'SUBSCRIPTION',
            granted: '1000',
            available: '0',
            upcoming: '0',
            used: '200',
            expired: '800',
            expires: true,
            usableNow: false,
            nextExpiresAt: null,
          },
          {
            source: 'PURCHASE',
            granted: '30',
            available: '26',
            upcoming: '0',
            used: '4',
            expired: '0',
            expires: false,
            usableNow: true,
            nextExpiresAt: null,
          },
          {
            source: 'REFERRAL',
            granted: '5',
            available: '0',
            upcoming: '0',
            used: '5',
            expired: '0',
            expires: false,
            usableNow: true,
            nextExpiresAt: null,
          },
          {
            source: 'DAILY_REWARD',
            granted: '0',
            available: '0',
            upcoming: '0',
            used: '0',
            expired: '0',
            expires: false,
            usableNow: true,
            nextExpiresAt: null,
          },
          {
            source: 'MISSION_REWARD',
            granted: '0',
            available: '0',
            upcoming: '0',
            used: '0',
            expired: '0',
            expires: false,
            usableNow: true,
            nextExpiresAt: null,
          },
        ]);

        // Each allocation with its dates; granted = available + used + expired.
        expect(
          balance.allocations.map((a) => [
            a.source,
            a.state,
            a.granted,
            a.available,
            a.used,
            a.expired,
            a.expiresAt,
            a.expiredAt,
          ]),
        ).toEqual([
          ['REFERRAL', 'USED_UP', '5', '0', '5', '0', null, null],
          ['PURCHASE', 'AVAILABLE', '30', '26', '4', '0', null, null],
          [
            'SUBSCRIPTION',
            'EXPIRED',
            '1000',
            '0',
            '200',
            '800',
            aliceProEnd.toISOString(),
            aliceProEnd.toISOString(),
          ],
          [
            'TRIAL',
            'EXPIRED',
            '50',
            '0',
            '10',
            '40',
            daysAgo(33).toISOString(),
            daysAgo(33).toISOString(),
          ],
        ]);
        for (const a of balance.allocations) {
          expect(
            Number(a.available) +
              Number(a.upcoming) +
              Number(a.used) +
              Number(a.expired),
          ).toBe(Number(a.granted));
        }
        // The numbers are the ledger's.
        const wallet = await ctx
          .get<CreditWalletService>(CreditWalletService)
          .getBalance(alice.id);
        expect(wallet.available).toBe(balance.available);
        await expectConsistentLedger(ctx.client, alice.id);
      });

      it('shows credits that expire with their next expiry date, and overage used beyond the balance', async () => {
        // An active Pro month: its credits count until the billing boundary.
        const bob = await signIn();
        const startedAt = daysAgo(10);
        const expiresAt = addBillingInterval(
          startedAt,
          BillingInterval.MONTHLY,
        );
        await givenPaidProHistory(
          ctx.client,
          bob.id,
          { billingInterval: BillingInterval.MONTHLY, startedAt },
          new Date(NOW),
        );
        const subscription =
          await ctx.client.userSubscription.findUniqueOrThrow({
            where: { authId: bob.id },
            include: { payments: true },
          });
        await wallet().grant(
          {
            authId: bob.id,
            source: CreditSource.SUBSCRIPTION,
            sourceReference: 'pro-month',
            amount: 1000,
            expiresAt,
            payment: {
              subscriptionId: subscription.id,
              paymentId: subscription.payments[0].id,
              periodStart: subscription.payments[0].periodStart,
            },
          },
          { at: startedAt },
        );
        const balance = await getBalance(bob);
        expect(balance).toMatchObject({
          available: '1000',
          usable: '1000',
          free: '1000',
          nextExpiration: {
            expiresAt: expiresAt.toISOString(),
            amount: '1000',
            sources: ['SUBSCRIPTION'],
          },
        });
        expect(sourceOf(balance, 'SUBSCRIPTION')).toMatchObject({
          available: '1000',
          usableNow: true,
          nextExpiresAt: expiresAt.toISOString(),
        });

        // Carol's session used 1 referral credit and 3 overage credits.
        const carolBalance = await getBalance(carol);
        expect(carolBalance).toMatchObject({
          available: '0',
          used: '1',
          overageUsed: '3',
        });
        expect(sourceOf(carolBalance, 'REFERRAL')).toMatchObject({
          granted: '1',
          used: '1',
          available: '0',
        });
      });

      it('shows a new user without credits every source at zero, and an empty history', async () => {
        const newcomer = await signIn();
        const balance = await getBalance(newcomer);
        expect(balance).toMatchObject({
          available: '0',
          usable: '0',
          reserved: '0',
          free: '0',
          granted: '0',
          used: '0',
          expired: '0',
          overageUsed: '0',
          nextExpiration: null,
          allocations: [],
        });
        expect(balance.sources.map((s) => [s.source, s.granted])).toEqual([
          ['TRIAL', '0'],
          ['SUBSCRIPTION', '0'],
          ['PURCHASE', '0'],
          ['REFERRAL', '0'],
          ['DAILY_REWARD', '0'],
          ['MISSION_REWARD', '0'],
        ]);
        await expect(getHistory(newcomer)).resolves.toEqual({
          items: [],
          nextCursor: null,
        });
        // Reading creates nothing.
        await expect(
          ctx.client.creditWallet.count({ where: { authId: newcomer.id } }),
        ).resolves.toBe(0);
      });

      it('shows the credits reserved by an unfinished session', async () => {
        const dave = await signIn();
        await givenCreditsInPostgres(ctx.client, dave.id, 'PURCHASE', '2.5');
        await newSession(dave);
        await expect(getBalance(dave)).resolves.toMatchObject({
          available: '2.5',
          reserved: '1',
          free: '1.5',
        });
      });
    });

    describe('GET /v1/credits/transactions', () => {
      it('lists allocations, deductions and expirations newest first, with amount, source, type, date and session', async () => {
        const { items, nextCursor } = await getHistory(alice);
        expect(nextCursor).toBeNull();
        // Oldest first for readability: the ledger order.
        const ledger = [...items].reverse();
        expect(
          ledger.map((t) => [t.type, t.source, t.amount, t.overageAmount]),
        ).toEqual([
          ['ALLOCATION', 'TRIAL', '50', '0'],
          ['DEDUCTION', 'TRIAL', '-10', '0'],
          ['ALLOCATION', 'SUBSCRIPTION', '1000', '0'],
          // Recorded by the next change after the trial's expiry.
          ['EXPIRATION', 'TRIAL', '-40', '0'],
          ['ALLOCATION', 'PURCHASE', '30', '0'],
          ['ALLOCATION', 'REFERRAL', '5', '0'],
          ['DEDUCTION', 'SUBSCRIPTION', '-200', '0'],
          ['EXPIRATION', 'SUBSCRIPTION', '-800', '0'],
          ['DEDUCTION', 'REFERRAL', '-5', '0'],
          ['DEDUCTION', 'PURCHASE', '-2', '0'],
          ['DEDUCTION', 'PURCHASE', '-0.5', '0'],
          ['DEDUCTION', 'PURCHASE', '-1.5', '0'],
        ]);
        // Dates: when each change took effect (expirations at the expiry).
        expect(ledger.map((t) => t.occurredAt).slice(0, 8)).toEqual([
          daysAgo(40).toISOString(),
          daysAgo(38).toISOString(),
          aliceProStart.toISOString(),
          daysAgo(33).toISOString(),
          daysAgo(30).toISOString(),
          daysAgo(25).toISOString(),
          daysAgo(20).toISOString(),
          aliceProEnd.toISOString(),
        ]);
        // The balance after each change, never negative.
        expect(ledger.map((t) => t.balanceAfter)).toEqual([
          '50',
          '40',
          '1040',
          '1000',
          '1030',
          '1035',
          '835',
          '35',
          '30',
          '28',
          '27.5',
          '26',
        ]);
        // Allocations name their expiry; purchased and referral credits have none.
        expect(
          ledger
            .filter((t) => t.type === 'ALLOCATION')
            .map((t) => t.sources[0].expiresAt),
        ).toEqual([
          daysAgo(33).toISOString(),
          aliceProEnd.toISOString(),
          null,
          null,
        ]);
        // AI deductions: the makeup session and the AI request they paid for.
        const ai = ledger.filter((t) => t.sessionId !== null);
        expect(ai).toHaveLength(4);
        for (const t of ai) {
          expect(t.sessionId).toBe(aliceSession);
          expect(t.session).toMatchObject({ id: aliceSession });
          expect(t.aiUsage).toMatchObject({
            creditCostUsdMicros: 5000,
            creditCostUsd: '0.005',
            creditsCharged: t.creditsCharged,
          });
        }
        expect(ai.map((t) => t.aiUsage?.runId)).toEqual(aliceRuns);
        expect(
          ledger.filter((t) => t.sessionId === null).every((t) => !t.aiUsage),
        ).toBe(true);
      });

      it('shows session overage as part of the deduction, and lists deductions that used overage', async () => {
        const { items } = await getHistory(carol);
        const deduction = items.find((t) => t.type === 'DEDUCTION');
        expect(deduction).toMatchObject({
          amount: '-1',
          overageAmount: '3',
          creditsCharged: '4',
          balanceAfter: '0',
          source: 'MIXED',
          sessionId: carolSession,
          sources: [
            expect.objectContaining({ source: 'REFERRAL', amount: '-1' }),
            {
              source: 'SESSION_OVERAGE',
              amount: '-3',
              allocationId: null,
              expiresAt: null,
            },
          ],
        });
        const overage = await getHistory(carol, '?type=OVERAGE');
        expect(overage.items.map((t) => t.id)).toEqual([deduction?.id]);
        await expect(getHistory(alice, '?type=OVERAGE')).resolves.toEqual({
          items: [],
          nextCursor: null,
        });
      });

      it('filters by type and by makeup session, and pages without gaps or duplicates', async () => {
        const all = (await getHistory(alice)).items;
        const expirations = await getHistory(alice, '?type=EXPIRATION');
        expect(expirations.items.map((t) => [t.source, t.amount])).toEqual([
          ['SUBSCRIPTION', '-800'],
          ['TRIAL', '-40'],
        ]);
        const allocations = await getHistory(alice, '?type=ALLOCATION');
        expect(allocations.items.map((t) => t.source)).toEqual([
          'REFERRAL',
          'PURCHASE',
          'SUBSCRIPTION',
          'TRIAL',
        ]);
        const deductions = await getHistory(alice, '?type=DEDUCTION');
        expect(deductions.items).toHaveLength(6);
        const session = await getHistory(alice, `?sessionId=${aliceSession}`);
        expect(session.items.map((t) => t.amount)).toEqual([
          '-1.5',
          '-0.5',
          '-2',
          '-5',
        ]);

        const pages: HistoryItem[][] = [];
        let cursor: string | null = null;
        do {
          const page: HistoryPage = await getHistory(
            alice,
            `?limit=5${cursor ? `&before=${cursor}` : ''}`,
          );
          pages.push(page.items);
          cursor = page.nextCursor;
        } while (cursor);
        expect(pages.map((page) => page.length)).toEqual([5, 5, 2]);
        expect(pages.flat().map((t) => t.id)).toEqual(all.map((t) => t.id));
      });

      it('keeps the history after credits and the subscription expired and after the session was deleted', async () => {
        // Alice's trial and Pro month expired and her subscription has ended.
        const subscription =
          await ctx.client.userSubscription.findUniqueOrThrow({
            where: { authId: alice.id },
          });
        expect(subscription.status).toBe('EXPIRED');

        // A user whose only credits expired has no balance, but the history.
        const erin = await signIn();
        await wallet().grant(
          {
            authId: erin.id,
            source: CreditSource.TRIAL,
            sourceReference: 'trial',
            amount: 50,
            expiresAt: daysAgo(1),
          },
          { at: daysAgo(8) },
        );
        await expect(getBalance(erin)).resolves.toMatchObject({
          available: '0',
          granted: '50',
          expired: '50',
        });
        // (The expiration is recorded once the wallet is next changed.)
        await wallet().expireCredits(erin.id);
        const history = await getHistory(erin);
        expect(history.items.map((t) => [t.type, t.source, t.amount])).toEqual([
          ['EXPIRATION', 'TRIAL', '-50'],
          ['ALLOCATION', 'TRIAL', '50'],
        ]);
        await as(erin, http().post('/v1/sessions')).expect(403);

        // A completed session is deleted: its deductions and AI usage stay.
        const frank = await signIn();
        await givenCreditsInPostgres(ctx.client, frank.id, 'PURCHASE', '10');
        const sessionId = await newSession(frank);
        await analyzed(frank, sessionId, { cost: usd(1) });
        const { steps } = await guided(frank, sessionId, { cost: usd(1) });
        for (const stepId of steps) {
          await as(frank, http().post(`/v1/guide-steps/${stepId}/complete`))
            .send({})
            .expect(201);
        }
        await as(frank, http().delete(`/v1/sessions/${sessionId}`)).expect(200);

        const after = await getHistory(frank, `?sessionId=${sessionId}`);
        expect(
          after.items.map((t) => [t.amount, t.sessionId, t.session]),
        ).toEqual([
          ['-1', sessionId, null],
          ['-1', sessionId, null],
        ]);
        const usage = await getUsage(frank, sessionId);
        expect(usage.totals).toMatchObject({
          requests: 2,
          creditsCharged: '2',
        });
      });
    });

    describe('GET /v1/sessions/:sessionId/ai-usage', () => {
      it('shows every AI request of the session once, with tokens, conversion rate, deducted credits and overage', async () => {
        const usage = await getUsage(alice, aliceSession);
        // One entry per OpenRouter request: the retried question's billed
        // failure too, the repeated request only once.
        expect(usage.usages).toHaveLength(aliceRequests);
        expect(usage.usages).toHaveLength(5);
        expect(new Set(usage.usages.map((u) => u.id)).size).toBe(5);
        expect(
          usage.usages.map((u) => [
            u.operation,
            u.outcome,
            u.inputTokens,
            u.outputTokens,
            u.costUsd,
            u.creditCostUsdMicros,
            u.creditCostUsd,
            u.creditsCharged,
            u.overageCredits,
            u.chargeStatus,
          ]),
        ).toEqual([
          [
            'PERSONALIZATION',
            'SUCCEEDED',
            1000,
            250,
            '0.025',
            5000,
            '0.005',
            '5',
            '0',
            'CHARGED',
          ],
          [
            'GUIDE_GENERATION',
            'SUCCEEDED',
            1000,
            250,
            '0.01',
            5000,
            '0.005',
            '2',
            '0',
            'CHARGED',
          ],
          [
            'GUIDE_QUESTION',
            'FAILED',
            1000,
            250,
            '0.002',
            null,
            null,
            null,
            null,
            'NOT_CHARGED',
          ],
          [
            'GUIDE_QUESTION',
            'SUCCEEDED',
            1000,
            250,
            '0.0025',
            5000,
            '0.005',
            '0.5',
            '0',
            'CHARGED',
          ],
          [
            'GUIDE_QUESTION',
            'SUCCEEDED',
            1000,
            250,
            '0.0075',
            5000,
            '0.005',
            '1.5',
            '0',
            'CHARGED',
          ],
        ]);
        expect(usage.totals).toEqual({
          requests: 5,
          inputTokens: 5000,
          outputTokens: 1250,
          totalTokens: 6250,
          costUsd: '0.047',
          creditsCharged: '9',
          overageCredits: '0',
          uncollectedCredits: '0',
        });
        // Each charged request links to its deduction in the history.
        const history = await getHistory(alice, `?sessionId=${aliceSession}`);
        expect(
          usage.usages
            .filter((u) => u.transactionId)
            .map((u) => u.transactionId)
            .reverse(),
        ).toEqual(history.items.map((t) => t.id));

        const carolUsage = await getUsage(carol, carolSession);
        expect(carolUsage.usages).toEqual([
          expect.objectContaining({
            creditsDue: '4',
            creditsCharged: '4',
            overageCredits: '3',
            creditCostUsdMicros: 5000,
          }),
        ]);
        expect(carolUsage.totals).toMatchObject({
          creditsCharged: '4',
          overageCredits: '3',
        });
        expect(carolUsage.credits).toMatchObject({
          overageLimit: '5',
          overageUsed: '3',
          overageRemaining: '2',
        });
      });
    });

    describe('access control', () => {
      const routes = () => [
        '/v1/credits/balance',
        '/v1/credits/transactions',
        `/v1/sessions/${aliceSession}/ai-usage`,
      ];

      it('rejects requests without a valid token', async () => {
        for (const route of routes()) {
          await http()
            .get(route)
            .set('X-Forwarded-For', '10.99.250.1')
            .expect(401);
          await http()
            .get(route)
            .set('X-Forwarded-For', '10.99.250.1')
            .set('Authorization', 'Bearer not-a-token')
            .expect(401);
          await http()
            .get(route)
            .set('X-Forwarded-For', '10.99.250.1')
            .set('Authorization', alice.auth.replace('Bearer', 'Basic'))
            .expect(401);
        }
      });

      it('rejects a token revoked by a security event', async () => {
        const gina = await signIn();
        await as(gina, http().get('/v1/credits/balance')).expect(200);
        await ctx.client.authUser.update({
          where: { id: gina.id },
          data: { tokenVersion: { increment: 1 } },
        });
        await as(gina, http().get('/v1/credits/balance')).expect(401);
        await as(gina, http().get('/v1/credits/transactions')).expect(401);
      });

      it("never shows another user's credits", async () => {
        // The user is the token's user; a user parameter is refused.
        for (const query of [`?authId=${carol.id}`, `?userId=${carol.id}`]) {
          await as(alice, http().get(`/v1/credits/balance${query}`)).expect(
            400,
          );
          await as(
            alice,
            http().get(`/v1/credits/transactions${query}`),
          ).expect(400);
        }
        // Another user's session is not found, like a missing one.
        const other = await as(
          alice,
          http().get(`/v1/credits/transactions?sessionId=${carolSession}`),
        ).expect(404);
        expect(other.body).toMatchObject({ message: 'Session not found' });
        await as(
          alice,
          http().get(`/v1/sessions/${carolSession}/ai-usage`),
        ).expect(404);
        await as(
          carol,
          http().get(`/v1/sessions/${aliceSession}/ai-usage`),
        ).expect(404);

        // Each sees only their own ledger.
        const aliceIds = (
          await ctx.client.creditTransaction.findMany({
            where: { authId: alice.id },
            select: { id: true },
          })
        ).map((t) => t.id);
        const aliceHistory = await getHistory(alice);
        expect(aliceHistory.items.map((t) => t.id).sort()).toEqual(
          [...aliceIds].sort(),
        );
        const carolHistory = await getHistory(carol);
        expect(carolHistory.items.some((t) => aliceIds.includes(t.id))).toBe(
          false,
        );
        expect((await getBalance(carol)).granted).toBe('1');
      });

      it.each([
        ['limit=0'],
        ['limit=101'],
        ['limit=ten'],
        ['before=abc'],
        ['before=0'],
        ['type=GRANT'],
        ['sessionId=not-a-uuid'],
      ])('rejects an invalid query (%s) with 400', async (query) => {
        await as(alice, http().get(`/v1/credits/transactions?${query}`)).expect(
          400,
        );
      });
    });
  },
);
