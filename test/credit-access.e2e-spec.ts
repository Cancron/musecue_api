// Must be first: sets REDIS_ENABLED=false (and an unreachable Redis) before
// any application module reads the environment.
import './support/env-postgres-mode';
import { CreditSource } from '@prisma/client';
import request from 'supertest';
import { CreditExpirySweepService } from '../src/credit/credit-expiry-sweep.service';
import { CreditWalletService } from '../src/credit/credit-wallet.service';
import { describeWithDatabase } from './support/migrated-schema';
import {
  bootApplication,
  eventually,
  type TestApplication,
} from './support/infrastructure-flows';
import { daysFrom, givenProPurchased } from './support/subscription-fixtures';

jest.setTimeout(120_000);

const HOUR = 3_600_000;

interface Account {
  id: string;
  email: string;
  password: string;
  ip: string;
}

/**
 * Credit-based access to makeup sessions through the complete application
 * (AppModule over HTTP, PostgreSQL only, captured emails): sign-up, email
 * verification and login over the real endpoints; purchased and referral
 * credits set up directly in PostgreSQL ("Credit_grant_manual"); results
 * checked in the PostgreSQL records.
 */
describeWithDatabase('Credit access to makeup sessions (e2e)', () => {
  let ctx: TestApplication;
  let wallets: CreditWalletService;
  let accounts = 0;

  const http = () => request(ctx.app.getHttpServer());
  const bearer = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    ctx = await bootApplication();
    wallets = ctx.get<CreditWalletService>(CreditWalletService);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /** Free sign-up with the emailed code, over HTTP. */
  const signUp = async (): Promise<Account> => {
    accounts += 1;
    const tag = `${Date.now().toString(36)}${accounts}`;
    const account = {
      email: `credit_${tag}@example.com`,
      password: 'correct horse battery staple',
      // One client address per account keeps per-IP rate limits apart.
      ip: `192.0.2.${accounts}`,
    };
    await http()
      .post('/auth')
      .set('X-Forwarded-For', account.ip)
      .send({
        username: `credit_${tag}`,
        email: account.email,
        password: account.password,
      })
      .expect(201);
    const sent = await eventually(
      () =>
        Promise.resolve(
          ctx.emails.sent.find(
            (mail) => mail.kind === 'verification' && mail.to === account.email,
          ),
        ),
      30_000,
      'the verification email',
    );
    await http()
      .post('/auth/verify-email')
      .set('X-Forwarded-For', account.ip)
      .send({ email: account.email, code: sent.code })
      .expect(201);
    const user = await ctx.client.authUser.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true },
    });
    return { id: user.id, ...account };
  };

  const login = async (account: Account): Promise<string> => {
    const response = await http()
      .post('/auth/login')
      .set('X-Forwarded-For', account.ip)
      .send({ email: account.email, password: account.password })
      .expect(201);
    return (response.body as { data: { accessToken: string } }).data
      .accessToken;
  };

  const createSession = (token: string) =>
    http().post('/v1/sessions').set('Authorization', bearer(token));

  /** Purchased or referral credits, set up directly in PostgreSQL. */
  const grantInPostgres = (
    authId: string,
    source: 'PURCHASE' | 'REFERRAL',
    reference: string,
    credits: number | string,
  ) =>
    ctx.client.$queryRaw<{ id: string }[]>`
      SELECT "Credit_grant_manual"(${authId}, ${source}::"CreditSource", ${reference}, ${String(credits)}::numeric) AS id`;

  /** The user's credit and session records in PostgreSQL. */
  const records = async (authId: string) => {
    const [row] = await ctx.client.$queryRaw<
      {
        wallets: number;
        allocations: number;
        transactions: number;
        balance: string | null;
        sessions: number;
      }[]
    >`
      SELECT (SELECT COUNT(*)::int FROM "CreditWallet" WHERE "authId" = ${authId}) AS wallets,
             (SELECT COUNT(*)::int FROM "CreditAllocation" a JOIN "CreditWallet" w ON w."id" = a."walletId" WHERE w."authId" = ${authId}) AS allocations,
             (SELECT COUNT(*)::int FROM "CreditTransaction" t JOIN "CreditWallet" w ON w."id" = t."walletId" WHERE w."authId" = ${authId}) AS transactions,
             (SELECT "balanceCredits"::text FROM "CreditWallet" WHERE "authId" = ${authId}) AS balance,
             (SELECT COUNT(*)::int FROM "MakeupSession" WHERE "authId" = ${authId}) AS sessions`;
    return row;
  };

  const NO_CREDIT_RECORDS = {
    wallets: 0,
    allocations: 0,
    transactions: 0,
    balance: null,
    sessions: 0,
  };

  /** A subscription whose paid monthly Pro term ended `daysAgo` days ago. */
  const givenExpiredPro = async (authId: string, daysAgo = 10) => {
    await ctx.client.userSubscription.create({ data: { authId } });
    const startedAt = daysFrom(new Date(), -(daysAgo + 31));
    await givenProPurchased(ctx.client, authId, {
      billingInterval: 'MONTHLY',
      startedAt,
    });
    const subscription = await ctx.client.userSubscription.findUniqueOrThrow({
      where: { authId },
    });
    expect(subscription.proExpiresAt!.getTime()).toBeLessThan(Date.now());
    return subscription;
  };

  describe('free users', () => {
    it('start with zero credits, and repeated logins never award any', async () => {
      const account = await signUp();
      await expect(records(account.id)).resolves.toEqual(NO_CREDIT_RECORDS);

      const tokens: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        tokens.push(await login(account));
        await expect(records(account.id)).resolves.toEqual(NO_CREDIT_RECORDS);
      }
      expect(tokens).toHaveLength(4);
      // Four real logins: each one stored its own refresh session.
      await expect(
        ctx.client.refreshSession.count({ where: { authId: account.id } }),
      ).resolves.toBe(4);

      await expect(wallets.getBalance(account.id)).resolves.toMatchObject({
        availableCredits: '0',
      });
      await expect(
        ctx.client.userSubscription.count({ where: { authId: account.id } }),
      ).resolves.toBe(0);
    });

    it('get 403 "Insufficient credits" from POST /v1/sessions, and nothing is created', async () => {
      const account = await signUp();
      const token = await login(account);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await createSession(token).expect(403);
        expect(response.body).toMatchObject({
          success: false,
          statusCode: 403,
          message: 'Insufficient credits',
        });
        expect(response.body).not.toHaveProperty('data');
      }

      await expect(records(account.id)).resolves.toEqual(NO_CREDIT_RECORDS);
    });

    it('can still use every other endpoint without credits', async () => {
      const account = await signUp();
      const token = await login(account);

      for (const path of [
        '/v1/sessions',
        '/v1/sessions?scope=all',
        '/v1/saved-recommendations',
        '/v1/profile',
        '/v1/profile/stats',
        '/v1/subscription',
      ]) {
        const response = await http()
          .get(path)
          .set('Authorization', bearer(token));
        expect([path, response.status]).toEqual([path, 200]);
      }
      await createSession(token).expect(403);
    });

    it('still need a valid access token (401 before any credit check)', async () => {
      await http().post('/v1/sessions').expect(401);
      await createSession('not-a-jwt').expect(401);
    });
  });

  describe('users with credits', () => {
    it.each(['PURCHASE', 'REFERRAL'] as const)(
      'can create sessions with %s credits set up directly in PostgreSQL',
      async (source) => {
        const account = await signUp();
        const token = await login(account);
        await createSession(token).expect(403);

        await grantInPostgres(account.id, source, `${source}:${account.id}`, 5);

        const created = await createSession(token).expect(201);
        const sessionId = (created.body as { data: { id: string } }).data.id;
        await createSession(token).expect(201);
        await expect(
          ctx.client.makeupSession.findUniqueOrThrow({
            where: { id: sessionId },
          }),
        ).resolves.toMatchObject({ authId: account.id, status: 'CREATED' });
        // Creating sessions does not use credits (charging is not implemented).
        await expect(records(account.id)).resolves.toEqual({
          wallets: 1,
          allocations: 1,
          transactions: 1,
          balance: '5.000000',
          sessions: 2,
        });
      },
    );

    it.each([CreditSource.TRIAL, CreditSource.SUBSCRIPTION])(
      'can create sessions with unexpired %s credits',
      async (source) => {
        const account = await signUp();
        const token = await login(account);
        await wallets.allocate({
          authId: account.id,
          source,
          sourceReference: `${source}:${account.id}`,
          credits: source === CreditSource.TRIAL ? 50 : 1000,
          expiresAt: new Date(Date.now() + 24 * HOUR),
        });

        await createSession(token).expect(201);
      },
    );

    it('only need some credits: a fraction of a credit is enough', async () => {
      const account = await signUp();
      const token = await login(account);
      await grantInPostgres(
        account.id,
        'REFERRAL',
        `tiny:${account.id}`,
        '0.000001',
      );

      await createSession(token).expect(201);
    });
  });

  describe('after the Pro subscription expired', () => {
    it('purchased and referral credits still allow creating sessions; expired subscription credits do not', async () => {
      const account = await signUp();
      const token = await login(account);
      const subscription = await givenExpiredPro(account.id);
      // The ended Pro period's monthly credits, expired with it.
      await wallets.allocate({
        authId: account.id,
        source: CreditSource.SUBSCRIPTION,
        sourceReference: `pro:${subscription.id}:last-period`,
        credits: 1000,
        expiresAt: subscription.proExpiresAt!,
        now: daysFrom(subscription.proExpiresAt!, -31),
      });

      const status = await http()
        .get('/v1/subscription')
        .set('Authorization', bearer(token))
        .expect(200);
      expect((status.body as { data: unknown }).data).toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
      });
      const refused = await createSession(token).expect(403);
      expect(refused.body).toMatchObject({ message: 'Insufficient credits' });

      await grantInPostgres(account.id, 'PURCHASE', `pack:${account.id}`, 20);
      await createSession(token).expect(201);

      await expect(wallets.getBalance(account.id)).resolves.toMatchObject({
        availableCredits: '20',
        availableBySource: { SUBSCRIPTION: '0', PURCHASE: '20' },
      });
    });

    it('referral credits alone are enough after Pro expired', async () => {
      const account = await signUp();
      const token = await login(account);
      await givenExpiredPro(account.id, 90);
      await grantInPostgres(account.id, 'REFERRAL', `ref:${account.id}`, 3);

      await createSession(token).expect(201);
    });
  });

  describe('expired credits', () => {
    it('no longer allow creating sessions, and the sweep records their expiry for an idle wallet', async () => {
      const account = await signUp();
      const token = await login(account);
      const expiresAt = new Date(Date.now() - HOUR);
      await wallets.allocate({
        authId: account.id,
        source: CreditSource.TRIAL,
        sourceReference: `trial:${account.id}`,
        credits: 50,
        expiresAt,
        now: new Date(expiresAt.getTime() - 7 * 24 * HOUR),
      });

      const refused = await createSession(token).expect(403);
      expect(refused.body).toMatchObject({ message: 'Insufficient credits' });
      // The refused request changed nothing; the expiry is not recorded yet.
      await expect(records(account.id)).resolves.toMatchObject({
        transactions: 1,
        balance: '50.000000',
      });

      // The scheduled sweep (run here directly) records it for the idle wallet.
      await ctx.get<CreditExpirySweepService>(CreditExpirySweepService).sweep();

      const history = await wallets.listTransactions(account.id);
      expect(history.map((t) => [t.type, t.amountCredits])).toEqual([
        ['EXPIRATION', '-50'],
        ['ALLOCATION', '50'],
      ]);
      expect(history[0].effectiveAt).toBe(expiresAt.toISOString());
      await expect(records(account.id)).resolves.toMatchObject({
        transactions: 2,
        balance: '0.000000',
        sessions: 0,
      });
    });
  });
});
