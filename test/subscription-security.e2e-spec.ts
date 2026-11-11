import {
  Controller,
  Get,
  Global,
  INestApplication,
  Module,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  BillingInterval,
  PaymentStatus,
  PrismaClient,
  userStatus,
} from '@prisma/client';
import { mock } from 'jest-mock-extended';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { UserRole } from '../src/auth/interfaces/auth.interface';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
import config from '../src/common/config/app.config';
import { AllExceptionsFilter } from '../src/common/filters/all-exception.filter';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { CustomLoggerService } from '../src/common/services/custom-logger.service';
import { PrismaService } from '../src/common/services/prisma.service';
import { RedisService } from '../src/common/services/redis.service';
import { addBillingInterval } from '../src/subscription/billing.validation';
import {
  ProAccessGuard,
  type ProAccessRequest,
} from '../src/subscription/pro-access.guard';
import { SubscriptionModule } from '../src/subscription/subscription.module';
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
  daysFrom,
  givenFreeRecord,
  givenPaidProHistory,
  recordPayment,
} from './support/subscription-fixtures';

jest.setTimeout(120_000);

@UseGuards(AuthGuard, ProAccessGuard)
@Controller('v1/test-pro-feature')
class ProFeatureTestController {
  @Get()
  use(@Req() req: ProAccessRequest) {
    return { accessSource: req.proAccess.accessSource };
  }
}

type Data = Record<string, unknown>;

/**
 * Security review of the subscription module against PostgreSQL through the
 * real HTTP stack: permissions, invalid requests, account eligibility, data
 * ownership, and attempts to change subscription state or gain Pro access
 * with client-supplied values.
 */
describeWithDatabase('Subscription security (PostgreSQL, full stack)', () => {
  let app: INestApplication<App>;
  let schema: string;
  let client: PrismaClient;
  let originalSecret: string;
  const redis = mock<RedisService>();
  const tokens = new AuthUtilsService(mock<RedisService>());
  const T0 = new Date('2026-03-01T09:30:00.000Z');

  const bearer = (userId: string, role: string = UserRole.USER) =>
    `Bearer ${tokens.createAccessToken({ userId, role: role as UserRole, tokenVersion: 1 })}`;
  const http = () => request(app.getHttpServer());
  const dataOf = (r: { body: unknown }) => (r.body as { data: Data }).data;
  const plan = () =>
    client.subscriptionPlan.findUnique({ where: { code: 'PRO' } });
  const subscriptionOf = (authId: string) =>
    client.userSubscription.findUnique({ where: { authId } });

  /** Everything a user could change, to prove nothing changed. */
  const snapshot = async (authId: string) => ({
    plan: await plan(),
    subscription: await subscriptionOf(authId),
    payments: await client.paymentTransaction.count({
      where: { subscription: { authId } },
    }),
    events: await client.subscriptionEvent.count({
      where: { subscription: { authId } },
    }),
    audit: await client.activityLogEvent.count(),
  });

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    client = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: TEST_DATABASE_URL as string },
        { schema },
      ),
    });

    @Global()
    @Module({
      providers: [
        { provide: PrismaService, useValue: client },
        { provide: CustomLoggerService, useValue: mock<CustomLoggerService>() },
      ],
      exports: [PrismaService, CustomLoggerService],
    })
    class DatabaseTestModule {}

    @Module({
      imports: [SubscriptionModule],
      controllers: [ProFeatureTestController],
      providers: [AuthGuard, RedisService],
    })
    class ProFeatureTestModule {}

    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'subscription-security-e2e-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseTestModule, SubscriptionModule, ProFeatureTestModule],
    })
      .overrideProvider(RedisService)
      .useValue(redis)
      .compile();
    app = moduleRef.createNestApplication();
    const logger = mock<Logger>();
    app.useGlobalFilters(new AllExceptionsFilter(logger));
    app.useGlobalInterceptors(new TransformInterceptor(logger));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(async () => {
    jest.useRealTimers();
    redis.get.mockResolvedValue(1 as never);
    await client.subscriptionPlan.deleteMany();
  });

  afterEach(() => jest.useRealTimers());

  describe('plan settings: permissions', () => {
    const patch = (userId: string, role: string, body: object) =>
      http()
        .patch('/v1/admin/subscription-plan')
        .set('Authorization', bearer(userId, role))
        .send(body);

    it.each([UserRole.ADMIN, UserRole.SUPERADMIN])(
      '%s can change every plan setting, and each change is persisted and attributed',
      async (role) => {
        const adminId = await createUser(client);
        const settings = [
          { monthlyPriceUsdCents: 2400 },
          { yearlyPriceUsdCents: 24000 },
          { trialDays: 14 },
          { trialEnabled: false },
          { planEnabled: false },
        ];
        for (const body of settings) {
          await patch(adminId, role, body).expect(200);
        }
        await expect(plan()).resolves.toMatchObject({
          monthlyPriceUsdCents: 2400,
          yearlyPriceUsdCents: 24000,
          trialDays: 14,
          trialEnabled: false,
          planEnabled: false,
        });
        await expect(
          client.activityLogEvent.count({
            where: { tableName: 'SubscriptionPlan', actionedBy: adminId },
          }),
        ).resolves.toBe(settings.length);
      },
    );

    it.each([UserRole.USER, UserRole.MODERATOR])(
      '%s cannot read or change any plan setting',
      async (role) => {
        const userId = await createUser(client);
        const before = await snapshot(userId);
        await http()
          .get('/v1/admin/subscription-plan')
          .set('Authorization', bearer(userId, role))
          .expect(403);
        for (const body of [
          { monthlyPriceUsdCents: 1 },
          { yearlyPriceUsdCents: 1 },
          { trialDays: 365 },
          { trialEnabled: true },
          { planEnabled: false },
        ]) {
          await patch(userId, role, body).expect(403);
        }
        await expect(snapshot(userId)).resolves.toEqual(before);
      },
    );

    it.each(['SUPER_ADMIN', 'CUSTOMER', 'admin', 'superadmin', ''])(
      'rejects the unknown role claim %p',
      async (role) => {
        const userId = await createUser(client);
        await patch(userId, role, { trialDays: 30 }).expect(403);
        await expect(plan()).resolves.toBeNull();
      },
    );

    it('rejects missing, forged, expired and revoked admin tokens', async () => {
      const adminId = await createUser(client);
      await http()
        .patch('/v1/admin/subscription-plan')
        .send({ trialDays: 30 })
        .expect(401);

      const secret = config.jwt_access_secret;
      config.jwt_access_secret = 'attacker-secret';
      const forged = bearer(adminId, UserRole.SUPERADMIN);
      config.jwt_access_secret = secret;
      await http()
        .patch('/v1/admin/subscription-plan')
        .set('Authorization', forged)
        .send({ trialDays: 30 })
        .expect(401);

      const expired = tokens.createAccessToken(
        { userId: adminId, role: UserRole.ADMIN, tokenVersion: 1 },
        -1,
      );
      await http()
        .patch('/v1/admin/subscription-plan')
        .set('Authorization', `Bearer ${expired}`)
        .send({ trialDays: 30 })
        .expect(401);

      redis.get.mockResolvedValue(2 as never); // tokenVersion bumped (e.g. logout-all)
      await patch(adminId, UserRole.ADMIN, { trialDays: 30 }).expect(401);

      await expect(plan()).resolves.toBeNull();
    });

    it.each(['put', 'post', 'delete'] as const)(
      'exposes no %s route for the plan',
      async (method) => {
        const adminId = await createUser(client);
        await http()
          [method]('/v1/admin/subscription-plan')
          .set('Authorization', bearer(adminId, UserRole.SUPERADMIN))
          .send({ trialDays: 30 })
          .expect(404);
        await expect(plan()).resolves.toBeNull();
      },
    );
  });

  describe('plan settings: invalid requests', () => {
    let adminId: string;
    beforeAll(async () => {
      adminId = await createUser(client);
    });
    const patchAsAdmin = (
      body: string | object,
      contentType = 'application/json',
    ) =>
      http()
        .patch('/v1/admin/subscription-plan')
        .set('Authorization', bearer(adminId, UserRole.ADMIN))
        .set('Content-Type', contentType)
        .send(typeof body === 'string' ? body : JSON.stringify(body));

    it.each([
      // prices
      ['a zero price', { monthlyPriceUsdCents: 0 }],
      ['a negative price', { yearlyPriceUsdCents: -19000 }],
      ['a fractional price (dollars)', { monthlyPriceUsdCents: 19.99 }],
      ['a price above the maximum', { yearlyPriceUsdCents: 1_000_000 }],
      ['a huge number', { monthlyPriceUsdCents: 1e308 }],
      ['a numeric string price', { monthlyPriceUsdCents: '1900' }],
      ['a null price', { monthlyPriceUsdCents: null }],
      [
        'an object price (operator injection)',
        { monthlyPriceUsdCents: { $gt: 0 } },
      ],
      ['an array price', { yearlyPriceUsdCents: [19000] }],
      // trial period
      ['a zero-day trial', { trialDays: 0 }],
      ['a negative trial', { trialDays: -7 }],
      ['a trial over 365 days', { trialDays: 366 }],
      ['a fractional trial', { trialDays: 7.5 }],
      ['a string trial', { trialDays: '7' }],
      // switches
      ['a string boolean', { planEnabled: 'false' }],
      ['a numeric boolean', { trialEnabled: 1 }],
      ['a null switch', { trialEnabled: null }],
      // billing period and other configuration that is not editable
      ['a billing interval', { billingInterval: 'WEEKLY' }],
      ['a billing period length', { billingPeriodDays: 7 }],
      ['a currency', { currency: 'EUR' }],
      ['a plan code', { code: 'FREE' }],
      ['a second plan', { plans: [{ code: 'TEAM' }] }],
      [
        'an updatedAt timestamp',
        { trialDays: 7, updatedAt: '2020-01-01T00:00:00Z' },
      ],
      ['a user subscription change', { authId: 'someone', status: 'PRO' }],
      // malformed bodies
      ['an empty object', {}],
      ['an array body', [{ monthlyPriceUsdCents: 2000 }]],
      ['a JSON null body', 'null'],
      ['a form-encoded body', 'monthlyPriceUsdCents=2000'],
    ])('rejects %s with 400 and changes nothing', async (_case, body) => {
      const contentType =
        _case === 'a form-encoded body'
          ? 'application/x-www-form-urlencoded'
          : 'application/json';
      const response = await patchAsAdmin(body as object, contentType).expect(
        400,
      );
      expect(response.body).toMatchObject({ success: false, statusCode: 400 });
      await expect(plan()).resolves.toBeNull();
    });

    it('ignores prototype-pollution keys: only whitelisted settings are written', async () => {
      const response = await patchAsAdmin(
        '{"__proto__":{"planEnabled":false,"isAdmin":true},"constructor":{"prototype":{"polluted":true}},"trialDays":10}',
      ).expect(200);
      expect(dataOf(response)).toMatchObject({
        trialDays: 10,
        planEnabled: true,
      });
      expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      await expect(plan()).resolves.toMatchObject({
        trialDays: 10,
        planEnabled: true,
      });
    });
  });

  describe('trial activation: account eligibility', () => {
    const activate = (userId: string) =>
      http()
        .post('/v1/subscription/trial')
        .set('Authorization', bearer(userId));

    it('activates for an active, verified account', async () => {
      const userId = await createUser(client);
      await activate(userId).expect(201);
    });

    it.each([
      ['an INACTIVE account', userStatus.INACTIVE, {}],
      ['a SUSPENDED account', userStatus.SUSPENDED, {}],
      ['a BLOCKED account', userStatus.BLOCKED, {}],
      ['a DELETED account', userStatus.DELETED, {}],
      [
        'an ACTIVE but unverified account',
        userStatus.ACTIVE,
        { verified: false },
      ],
      [
        'an ACTIVE but soft-deleted account',
        userStatus.ACTIVE,
        { deletedAt: T0 },
      ],
    ])(
      'refuses %s and reports it as ineligible',
      async (_case, status, account) => {
        const userId = await createUser(client, status, account);
        const response = await activate(userId).expect(403);
        expect(response.body).toMatchObject({
          message: 'Only active accounts can start a free trial',
        });
        await expect(subscriptionOf(userId)).resolves.toBeNull();

        const view = await http()
          .get('/v1/subscription')
          .set('Authorization', bearer(userId))
          .expect(200);
        expect(dataOf(view)).toMatchObject({
          trial: { eligible: false, ineligibleReason: 'ACCOUNT_INACTIVE' },
        });
      },
    );
  });

  describe('disabled plan and trial', () => {
    it.each([[{ trialEnabled: false }], [{ planEnabled: false }]])(
      'with %p a trial cannot be activated and nothing is recorded',
      async (settings) => {
        const adminId = await createUser(client);
        await http()
          .patch('/v1/admin/subscription-plan')
          .set('Authorization', bearer(adminId, UserRole.ADMIN))
          .send(settings)
          .expect(200);
        const userId = await createUser(client);
        const before = await snapshot(userId);

        await http()
          .post('/v1/subscription/trial')
          .set('Authorization', bearer(userId))
          .expect(403);
        await expect(snapshot(userId)).resolves.toEqual(before);
      },
    );
  });

  describe('client-supplied values cannot change subscription state or access', () => {
    it('ignores a trial request body that tries to set status, dates, duration or another user', async () => {
      const userId = await createUser(client);
      const victim = await createUser(client);
      freezeTime(T0);
      const response = await http()
        .post(`/v1/subscription/trial?authId=${victim}&trialDays=365`)
        .set('Authorization', bearer(userId))
        .send({
          authId: victim,
          userId: victim,
          status: 'PRO',
          trialDays: 365,
          trialStartedAt: '2020-01-01T00:00:00Z',
          trialExpiresAt: '2099-01-01T00:00:00Z',
          proStartedAt: '2020-01-01T00:00:00Z',
          proExpiresAt: '2099-01-01T00:00:00Z',
          billingInterval: 'YEARLY',
          hasProAccess: true,
        })
        .expect(201);

      expect(dataOf(response)).toMatchObject({
        status: 'TRIAL',
        accessSource: 'TRIAL',
        trialStartedAt: T0.toISOString(),
        trialExpiresAt: daysFrom(T0, 7).toISOString(),
      });
      await expect(subscriptionOf(userId)).resolves.toMatchObject({
        status: 'TRIAL',
        trialStartedAt: T0,
        trialExpiresAt: daysFrom(T0, 7),
        billingInterval: null,
        proStartedAt: null,
        proExpiresAt: null,
      });
      await expect(subscriptionOf(victim)).resolves.toBeNull();
    });

    it.each([
      ['patch', '/v1/subscription'],
      ['put', '/v1/subscription'],
      ['post', '/v1/subscription'],
      ['delete', '/v1/subscription'],
      ['patch', '/v1/subscription/trial'],
      ['delete', '/v1/subscription/trial'],
      ['post', '/v1/subscription/pro'],
      ['post', '/v1/subscription/activate'],
      ['post', '/v1/subscription/renew'],
      ['post', '/v1/subscription/cancel'],
      ['post', '/v1/subscription/payments'],
      ['get', '/v1/subscription/payments'],
      ['patch', '/v1/subscription/payments/any-id'],
      ['post', '/v1/payments'],
      ['post', '/v1/payments/webhook'],
      ['post', '/v1/admin/subscriptions'],
      ['patch', '/v1/admin/subscriptions/any-user'],
    ] as const)('has no %s %s route', async (method, path) => {
      const userId = await createUser(client);
      const before = await snapshot(userId);
      await http()
        [method](path)
        .set('Authorization', bearer(userId, UserRole.SUPERADMIN))
        .send({
          status: 'PRO',
          proExpiresAt: '2099-01-01T00:00:00Z',
          amountCents: 1900,
          paymentStatus: 'SUCCEEDED',
        })
        .expect(404);
      await expect(snapshot(userId)).resolves.toEqual(before);
    });

    it('does not grant Pro access from spoofed headers, query parameters or body', async () => {
      const userId = await createUser(client);
      await http()
        .get(
          '/v1/test-pro-feature?hasProAccess=true&status=PRO&accessSource=PRO',
        )
        .set('Authorization', bearer(userId))
        .set('X-Pro-Access', 'true')
        .set('X-Subscription-Status', 'PRO')
        .send({ hasProAccess: true, status: 'PRO' })
        .expect(403);
    });

    it('does not grant Pro access from an elevated role claim', async () => {
      const adminId = await createUser(client);
      await http()
        .get('/v1/test-pro-feature')
        .set('Authorization', bearer(adminId, UserRole.SUPERADMIN))
        .expect(403);
    });
  });

  describe('data ownership', () => {
    it('each user reads only their own subscription; other users’ IDs in the request are ignored', async () => {
      const trialUser = await createUser(client);
      const proUser = await createUser(client);
      await http()
        .post('/v1/subscription/trial')
        .set('Authorization', bearer(trialUser))
        .expect(201);
      await givenPaidProHistory(
        client,
        proUser,
        {
          billingInterval: BillingInterval.YEARLY,
          startedAt: daysFrom(new Date(), -1),
        },
        new Date(),
      );

      const own = await http()
        .get(`/v1/subscription?authId=${proUser}&userId=${proUser}`)
        .set('Authorization', bearer(trialUser))
        .send({ authId: proUser })
        .expect(200);
      expect(dataOf(own)).toMatchObject({
        status: 'TRIAL',
        pro: { billingInterval: null, startedAt: null },
      });
      await http()
        .get(`/v1/subscription/${proUser}`)
        .set('Authorization', bearer(trialUser))
        .expect(404);

      // The Pro user's access does not leak to the trial user after the trial.
      freezeTime(daysFrom(new Date(), 8));
      await http()
        .get(`/v1/test-pro-feature?authId=${proUser}`)
        .set('Authorization', bearer(trialUser))
        .expect(403);
    });

    it('the status response exposes no payment-provider identifiers', async () => {
      const userId = await createUser(client);
      await givenPaidProHistory(
        client,
        userId,
        {
          billingInterval: BillingInterval.MONTHLY,
          startedAt: daysFrom(new Date(), -1),
        },
        new Date(),
      );
      await client.userSubscription.update({
        where: { authId: userId },
        data: {
          paymentProvider: 'stripe',
          providerSubscriptionId: 'sub_secret',
        },
      });
      const response = await http()
        .get('/v1/subscription')
        .set('Authorization', bearer(userId))
        .expect(200);
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain('sub_secret');
      expect(raw).not.toContain('stripe');
      expect(raw).not.toContain('providerPaymentId');
      expect(raw).not.toContain(userId);
    });
  });

  describe('payments: no Pro without verified payment processing', () => {
    it.each([PaymentStatus.PENDING, PaymentStatus.FAILED])(
      'a user whose only payment is %s has no Pro access and can still be offered the trial',
      async (status) => {
        const userId = await createUser(client);
        const record = await givenFreeRecord(client, userId);
        const start = daysFrom(new Date(), -1);
        await recordPayment(client, record.id, {
          status,
          periodStart: start,
          periodEnd: addBillingInterval(start, BillingInterval.MONTHLY),
        });

        const view = await http()
          .get('/v1/subscription')
          .set('Authorization', bearer(userId))
          .expect(200);
        expect(dataOf(view)).toMatchObject({
          status: 'FREE',
          hasProAccess: false,
          pro: { active: false, startedAt: null },
          trial: { eligible: true },
        });
        await http()
          .get('/v1/test-pro-feature')
          .set('Authorization', bearer(userId))
          .expect(403);
      },
    );

    it('a pending renewal does not extend Pro access past the paid period', async () => {
      const userId = await createUser(client);
      const start = daysFrom(new Date(), -20);
      const paidUntil = addBillingInterval(start, BillingInterval.MONTHLY);
      const purchased = await givenPaidProHistory(
        client,
        userId,
        { billingInterval: BillingInterval.MONTHLY, startedAt: start },
        new Date(),
      );
      await recordPayment(client, purchased.id, {
        status: PaymentStatus.PENDING,
        periodStart: paidUntil,
        periodEnd: addBillingInterval(paidUntil, BillingInterval.MONTHLY),
      });

      freezeTime(new Date(paidUntil.getTime() - 1));
      await http()
        .get('/v1/test-pro-feature')
        .set('Authorization', bearer(userId))
        .expect(200);
      freezeTime(paidUntil);
      await http()
        .get('/v1/test-pro-feature')
        .set('Authorization', bearer(userId))
        .expect(403);
      const view = await http()
        .get('/v1/subscription')
        .set('Authorization', bearer(userId))
        .expect(200);
      expect(dataOf(view)).toMatchObject({
        status: 'EXPIRED',
        pro: { expiresAt: paidUntil.toISOString() },
      });
    });

    it('no API request can create a payment, a paid term or a lifecycle event', async () => {
      const userId = await createUser(client);
      const adminId = await createUser(client);
      const attempts = [
        http()
          .post('/v1/subscription/trial')
          .set('Authorization', bearer(userId))
          .send({ paymentStatus: 'SUCCEEDED', amountCents: 1900 }),
        http()
          .get('/v1/subscription')
          .set('Authorization', bearer(userId))
          .query({ status: 'PRO' }),
        http()
          .patch('/v1/admin/subscription-plan')
          .set('Authorization', bearer(adminId, UserRole.SUPERADMIN))
          .send({ authId: userId, proExpiresAt: '2099-01-01T00:00:00Z' }),
      ];
      for (const attempt of attempts) await attempt;

      await expect(
        client.paymentTransaction.count({
          where: { subscription: { authId: userId } },
        }),
      ).resolves.toBe(0);
      await expect(subscriptionOf(userId)).resolves.toMatchObject({
        status: 'TRIAL',
        proStartedAt: null,
        proExpiresAt: null,
      });
      await expect(
        client.subscriptionEvent.count({
          where: { subscription: { authId: userId } },
        }),
      ).resolves.toBe(0);
    });
  });
});
