// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { BillingInterval, CreditSource, userStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { CreditExpirationSweepService } from '../src/credits/credit-expiration-sweep.service';
import { InsufficientCreditsError } from '../src/credits/credit-wallet.errors';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import { addBillingInterval } from '../src/subscription/billing.validation';
import { givenCreditsInPostgres } from './support/credit-fixtures';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  eventually,
  type TestApplication,
} from './support/infrastructure-flows';
import { describeWithDatabase } from './support/migrated-schema';
import { daysFrom, givenPaidProHistory } from './support/subscription-fixtures';

jest.setTimeout(180_000);

const PASSWORD = 'credit access e2e password';
const INSUFFICIENT = {
  success: false,
  statusCode: 403,
  message: 'Insufficient credits',
};

interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
}
const dataOf = <T>(response: { body: unknown }) =>
  (response.body as Envelope<T>).data;

interface Account {
  id: string;
  email: string;
}

/**
 * Credit-based access to POST /v1/sessions through the complete application
 * (AppModule, real HTTP endpoints, guards and sign-in) against a migrated
 * PostgreSQL schema. Free accounts sign up through the API; paid Pro history
 * uses PostgreSQL fixtures; purchased and referral credits are set up
 * directly in PostgreSQL (they are not issued by the API yet). No external
 * service is contacted.
 */
describeWithDatabase('Credit-based access to makeup sessions (e2e)', () => {
  let ctx: TestApplication;
  let ipCounter = 0;
  /** A distinct client address, so per-IP rate limits never interfere. */
  const nextIp = () => {
    ipCounter += 1;
    return `10.${Math.floor(ipCounter / 250) + 1}.${ipCounter % 250}.7`;
  };
  const http = () => request(ctx.app.getHttpServer());

  /** Registration with the emailed code, as a real user signs up. */
  const signUp = async (): Promise<Account> => {
    const tag = randomBytes(5).toString('hex');
    const email = `free_${tag}@example.com`;
    const ip = nextIp();
    await http()
      .post('/auth')
      .set('X-Forwarded-For', ip)
      .send({ username: `free_${tag}`, email, password: PASSWORD })
      .expect(201);
    const sent = await eventually(
      () =>
        Promise.resolve(
          ctx.emails.sent.find(
            (item) => item.kind === 'verification' && item.to === email,
          ),
        ),
      30_000,
      'the verification email',
    );
    await http()
      .post('/auth/verify-email')
      .set('X-Forwarded-For', ip)
      .send({ email, code: sent.code })
      .expect(201);
    const user = await ctx.client.authUser.findUniqueOrThrow({
      where: { email },
    });
    return { id: user.id, email };
  };

  /** A verified account created in PostgreSQL (for subscription fixtures). */
  const createAccount = async (): Promise<Account> => {
    const tag = randomBytes(5).toString('hex');
    const email = `user_${tag}@example.com`;
    const user = await ctx.client.authUser.create({
      data: {
        email,
        username: `user_${tag}`,
        password: await bcrypt.hash(PASSWORD, 4),
        verified: true,
        status: userStatus.ACTIVE,
      },
    });
    return { id: user.id, email };
  };

  /** Signs in through POST /auth/login at the current (possibly frozen) time. */
  const signIn = async (account: Account): Promise<string> => {
    const response = await http()
      .post('/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({ email: account.email, password: PASSWORD })
      .expect(201);
    return `Bearer ${dataOf<{ accessToken: string }>(response).accessToken}`;
  };

  const createSession = (auth: string) =>
    http()
      .post('/v1/sessions')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', auth);

  /** Every credit record of a user in PostgreSQL. */
  const creditRecords = async (authId: string) => ({
    wallets: await ctx.client.creditWallet.count({ where: { authId } }),
    allocations: await ctx.client.creditAllocation.count({ where: { authId } }),
    transactions: await ctx.client.creditTransaction.count({
      where: { authId },
    }),
  });
  const sessionsOf = (authId: string) =>
    ctx.client.makeupSession.count({ where: { authId } });
  const allocationsOf = (authId: string) =>
    // Not by time: PostgreSQL-side setups use the database clock, the
    // application the (frozen) test clock.
    ctx.client.creditAllocation.findMany({
      where: { authId },
      orderBy: [{ source: 'asc' }, { sourceReference: 'asc' }],
    });

  beforeAll(async () => {
    ctx = await bootApplication();
  });

  afterAll(async () => {
    jest.useRealTimers();
    await ctx?.close();
  });

  afterEach(() => jest.useRealTimers());

  describe('free users', () => {
    it('start with zero credits, and repeated sign-ins award none', async () => {
      const account = await signUp();
      const none = { wallets: 0, allocations: 0, transactions: 0 };
      await expect(creditRecords(account.id)).resolves.toEqual(none);

      // Sign-in is limited to 5 attempts per email in 15 minutes; together
      // with the sign-in below this stays within it.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await signIn(account);
      }

      await expect(creditRecords(account.id)).resolves.toEqual(none);
      const auth = await signIn(account);
      const status = await http()
        .get('/v1/subscription')
        .set('Authorization', auth)
        .expect(200);
      expect(dataOf(status)).toMatchObject({
        status: 'FREE',
        hasProAccess: false,
      });
    });

    it('receive 403 "Insufficient credits" from POST /v1/sessions, and nothing is written', async () => {
      const account = await signUp();
      const auth = await signIn(account);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await createSession(auth).expect(403);
        expect(response.body).toMatchObject(INSUFFICIENT);
      }

      await expect(sessionsOf(account.id)).resolves.toBe(0);
      await expect(creditRecords(account.id)).resolves.toEqual({
        wallets: 0,
        allocations: 0,
        transactions: 0,
      });
    });

    it('can still use every other endpoint', async () => {
      const account = await signUp();
      // A session from before (e.g. created while the user had credits).
      const existing = await ctx.client.makeupSession.create({
        data: { authId: account.id },
      });
      const auth = await signIn(account);
      await createSession(auth).expect(403);

      for (const path of [
        '/v1/sessions',
        `/v1/sessions/${existing.id}`,
        '/v1/saved-recommendations',
        '/v1/profile',
        '/v1/profile/stats',
        '/v1/subscription',
      ]) {
        await http().get(path).set('Authorization', auth).expect(200);
      }
      const list = await http()
        .get('/v1/sessions?scope=all')
        .set('Authorization', auth)
        .expect(200);
      expect(JSON.stringify(list.body)).toContain(existing.id);
    });

    it('are rejected with 401, not 403, without a valid token', async () => {
      await http().post('/v1/sessions').expect(401);
      await http()
        .post('/v1/sessions')
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
    });
  });

  describe('purchased and referral credits (set up in PostgreSQL)', () => {
    it.each(['PURCHASE', 'REFERRAL'] as const)(
      'let a free user with %s credits create sessions',
      async (source) => {
        const account = await signUp();
        const auth = await signIn(account);
        await createSession(auth).expect(403);

        await givenCreditsInPostgres(ctx.client, account.id, source, '2.5');
        const created = await createSession(auth).expect(201);

        const session = dataOf<{ id: string }>(created);
        await expect(
          ctx.client.makeupSession.findUniqueOrThrow({
            where: { id: session.id },
          }),
        ).resolves.toMatchObject({ authId: account.id });
        await expect(
          ctx
            .get<CreditWalletService>(CreditWalletService)
            .getBalance(account.id),
        ).resolves.toMatchObject({ available: '2.5' });
      },
    );

    it('stay valid after the Pro subscription expires, while subscription credits do not', async () => {
      const account = await createAccount();
      const t0 = new Date('2031-04-10T09:00:00.000Z');
      const termEnds = addBillingInterval(t0, BillingInterval.MONTHLY);
      await givenPaidProHistory(
        ctx.client,
        account.id,
        { billingInterval: BillingInterval.MONTHLY, startedAt: t0 },
        t0,
      );

      // During the term: the monthly Pro allowance is granted and used.
      freezeTime(daysFrom(t0, 10));
      await createSession(await signIn(account)).expect(201);
      await givenCreditsInPostgres(ctx.client, account.id, 'PURCHASE', '20');
      await givenCreditsInPostgres(ctx.client, account.id, 'REFERRAL', '5');
      expect(
        (await allocationsOf(account.id)).map((a) => [
          a.source,
          a.amount.toFixed(),
          a.expiresAt?.toISOString() ?? null,
        ]),
      ).toEqual([
        ['SUBSCRIPTION', '1000', termEnds.toISOString()],
        ['PURCHASE', '20', null],
        ['REFERRAL', '5', null],
      ]);

      // After the term: no Pro, but purchased and referral credits still work.
      freezeTime(daysFrom(termEnds, 3));
      const auth = await signIn(account);
      const status = await http()
        .get('/v1/subscription')
        .set('Authorization', auth)
        .expect(200);
      expect(dataOf(status)).toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
      });
      await createSession(auth).expect(201);
      await createSession(auth).expect(201);
      await expect(sessionsOf(account.id)).resolves.toBe(3);
      await expect(
        ctx
          .get<CreditWalletService>(CreditWalletService)
          .getBalance(account.id),
      ).resolves.toMatchObject({
        available: '25',
        bySource: { SUBSCRIPTION: '0', PURCHASE: '20', REFERRAL: '5' },
      });
      // No new Pro allowance after the term.
      await expect(
        ctx.client.creditAllocation.count({
          where: { authId: account.id, source: CreditSource.SUBSCRIPTION },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('trial and subscription credits', () => {
    it('are granted when a free user starts the trial, and end with it', async () => {
      const account = await signUp();
      let auth = await signIn(account);
      await createSession(auth).expect(403);

      await http()
        .post('/v1/subscription/trial')
        .set('Authorization', auth)
        .expect(201);
      await createSession(auth).expect(201);
      await createSession(auth).expect(201);

      const subscription = await ctx.client.userSubscription.findUniqueOrThrow({
        where: { authId: account.id },
      });
      const [trialCredits, ...others] = await allocationsOf(account.id);
      expect(others).toEqual([]);
      expect(trialCredits).toMatchObject({
        source: 'TRIAL',
        expiresAt: subscription.trialExpiresAt,
      });
      expect(trialCredits.amount.toFixed()).toBe('50');

      freezeTime(subscription.trialExpiresAt as Date);
      auth = await signIn(account);
      const response = await createSession(auth).expect(403);
      expect(response.body).toMatchObject(INSUFFICIENT);
    });

    it('deny sessions once the only credits came from an expired Pro term, and record their expiration', async () => {
      const account = await createAccount();
      const t0 = new Date('2032-01-31T12:00:00.000Z');
      const termEnds = addBillingInterval(t0, BillingInterval.MONTHLY);
      await givenPaidProHistory(
        ctx.client,
        account.id,
        { billingInterval: BillingInterval.MONTHLY, startedAt: t0 },
        t0,
      );
      freezeTime(daysFrom(t0, 1));
      await createSession(await signIn(account)).expect(201);

      freezeTime(termEnds);
      const auth = await signIn(account);
      const denied = await createSession(auth).expect(403);
      expect(denied.body).toMatchObject(INSUFFICIENT);

      // The unused allowance's expiration is traceable in the history.
      await ctx
        .get<CreditExpirationSweepService>(CreditExpirationSweepService)
        .sweep();
      const history = await ctx.client.creditTransaction.findMany({
        where: { authId: account.id },
        orderBy: { sequence: 'asc' },
      });
      expect(
        history.map((t) => [
          t.type,
          t.amount.toFixed(),
          t.balanceAfter.toFixed(),
        ]),
      ).toEqual([
        ['GRANT', '1000', '1000'],
        ['EXPIRATION', '-1000', '0'],
      ]);

      // Referral credits restore access without Pro.
      await givenCreditsInPostgres(ctx.client, account.id, 'REFERRAL', '1');
      await createSession(auth).expect(201);
    });

    it('stop counting when a refund ends the paid term early, although they have not expired', async () => {
      const account = await createAccount();
      const t0 = new Date('2034-03-01T00:00:00.000Z');
      await givenPaidProHistory(
        ctx.client,
        account.id,
        { billingInterval: BillingInterval.MONTHLY, startedAt: t0 },
        t0,
      );
      freezeTime(daysFrom(t0, 3));
      await createSession(await signIn(account)).expect(201);
      const [allowance] = await allocationsOf(account.id);
      expect(allowance.expiresAt).toEqual(
        addBillingInterval(t0, BillingInterval.MONTHLY),
      );

      // A refund ends the term now, as StripeRefundService.revokeAccess does.
      freezeTime(daysFrom(t0, 5));
      await ctx.client.userSubscription.update({
        where: { authId: account.id },
        data: { proExpiresAt: daysFrom(t0, 5), status: 'EXPIRED' },
      });

      const auth = await signIn(account);
      const denied = await createSession(auth).expect(403);
      expect(denied.body).toMatchObject(INSUFFICIENT);
      // The 1000 credits are still in the wallet, unexpired, but unusable.
      await expect(
        ctx
          .get<CreditWalletService>(CreditWalletService)
          .getBalance(account.id),
      ).resolves.toMatchObject({ bySource: { SUBSCRIPTION: '1000' } });
    });

    it("grant each month's Pro allowance once, even under concurrent requests", async () => {
      const account = await createAccount();
      const t0 = new Date('2033-05-15T00:00:00.000Z');
      await givenPaidProHistory(
        ctx.client,
        account.id,
        { billingInterval: BillingInterval.YEARLY, startedAt: t0 },
        t0,
      );
      freezeTime(daysFrom(t0, 2));
      let auth = await signIn(account);

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => createSession(auth)),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(8).fill(201));
      await expect(sessionsOf(account.id)).resolves.toBe(8);

      // The next month of the yearly term brings the next allowance.
      freezeTime(daysFrom(t0, 33));
      auth = await signIn(account);
      await createSession(auth).expect(201);

      // Both months are paid by the one yearly payment.
      const yearly = await ctx.client.paymentTransaction.findFirstOrThrow({
        where: { subscription: { authId: account.id } },
      });
      expect(
        (await allocationsOf(account.id)).map((a) => [
          a.source,
          a.sourceReference,
          a.amount.toFixed(),
          a.paymentId,
          a.periodStart?.toISOString(),
          a.periodEnd?.toISOString(),
        ]),
      ).toEqual([
        [
          'SUBSCRIPTION',
          `payment:${yearly.id}:${t0.toISOString()}`,
          '1000',
          yearly.id,
          t0.toISOString(),
          '2033-06-15T00:00:00.000Z',
        ],
        [
          'SUBSCRIPTION',
          `payment:${yearly.id}:2033-06-15T00:00:00.000Z`,
          '1000',
          yearly.id,
          '2033-06-15T00:00:00.000Z',
          '2033-07-15T00:00:00.000Z',
        ],
      ]);
    });
  });

  it('denies users whose credits have run out', async () => {
    const account = await signUp();
    await givenCreditsInPostgres(ctx.client, account.id, 'PURCHASE', '0.75');
    const auth = await signIn(account);
    await createSession(auth).expect(201);

    await ctx.get<CreditWalletService>(CreditWalletService).debit({
      authId: account.id,
      amount: '0.75',
      idempotencyKey: 'used-up',
    });

    const response = await createSession(auth).expect(403);
    expect(response.body).toMatchObject(INSUFFICIENT);

    // A debit beyond the balance fails with the same status and message.
    const debit = await ctx
      .get<CreditWalletService>(CreditWalletService)
      .debit({ authId: account.id, amount: '0.5', idempotencyKey: 'more' })
      .catch((error: unknown) => error);
    expect(debit).toBeInstanceOf(InsufficientCreditsError);
    expect((debit as InsufficientCreditsError).getStatus()).toBe(
      INSUFFICIENT.statusCode,
    );
    expect((debit as InsufficientCreditsError).message).toBe(
      INSUFFICIENT.message,
    );
  });
});
