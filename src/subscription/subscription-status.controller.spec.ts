import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BillingInterval,
  SubscriptionStatus,
  type SubscriptionPlan,
  type UserSubscription,
} from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { UserRole } from '../auth/interfaces/auth.interface';
import { AuthUtilsService } from '../auth/services/auth-utils.service';
import config from '../common/config/app.config';
import { AllExceptionsFilter } from '../common/filters/all-exception.filter';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import { RedisService } from '../common/services/redis.service';
import { SubscriptionModule } from './subscription.module';

const prisma = mockDeep<PrismaService>();
const redis = mock<RedisService>();

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: CustomLoggerService, useValue: mock<CustomLoggerService>() },
  ],
  exports: [PrismaService, CustomLoggerService],
})
class TestInfrastructureModule {}

const ROUTE = '/v1/subscription';
const T0 = new Date('2026-03-01T00:00:00.000Z');
const at = (days: number, ms = 0) =>
  new Date(T0.getTime() + days * 86_400_000 + ms);

/** Fake only `Date`; timers stay real so Nest and supertest keep working. */
const freezeTime = (now: Date) =>
  jest.useFakeTimers({
    now,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });

type Row = Omit<UserSubscription, 'id' | 'authId' | 'createdAt' | 'updatedAt'>;
const row = (overrides: Partial<Row> = {}): Row => ({
  status: SubscriptionStatus.FREE,
  trialUsed: false,
  trialStartedAt: null,
  trialExpiresAt: null,
  billingInterval: null,
  proStartedAt: null,
  proExpiresAt: null,
  proCanceledAt: null,
  paymentProvider: null,
  providerSubscriptionId: null,
  ...overrides,
});
const trialRow = (start: number, end: number): Partial<Row> => ({
  trialUsed: true,
  trialStartedAt: at(start),
  trialExpiresAt: at(end),
});
const proRow = (
  start: number,
  end: number,
  billingInterval: BillingInterval = BillingInterval.MONTHLY,
): Partial<Row> => ({
  billingInterval,
  proStartedAt: at(start),
  proExpiresAt: at(end),
});

describe('GET /v1/subscription (HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  const tokens = new AuthUtilsService(mock<RedisService>());

  // In-memory stand-ins for the database, keyed like the real tables.
  let subscriptions: Map<string, Row>;
  let accountStatus: Map<string, string>;
  let unverified: Set<string>;
  let softDeleted: Set<string>;
  let plan: Partial<SubscriptionPlan> | null;

  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;
  const getAs = (userId: string, path = ROUTE) =>
    request(app.getHttpServer()).get(path).set('Authorization', bearer(userId));
  const dataOf = (response: { body: unknown }) =>
    (response.body as { data: Record<string, unknown> }).data;

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'subscription-status-spec-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, SubscriptionModule],
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
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    freezeTime(at(10));
    subscriptions = new Map();
    unverified = new Set();
    softDeleted = new Set();
    accountStatus = new Map([
      ['user-a', 'ACTIVE'],
      ['user-b', 'ACTIVE'],
    ]);
    plan = null; // defaults: plan and 7-day trial enabled
    redis.get.mockResolvedValue(1 as never); // current tokenVersion
    prisma.userSubscription.findUnique.mockImplementation(((args: {
      where: { authId: string };
    }) =>
      Promise.resolve(subscriptions.get(args.where.authId) ?? null)) as never);
    prisma.authUser.findUnique.mockImplementation(((args: {
      where: { id: string };
    }) => {
      const status = accountStatus.get(args.where.id);
      return Promise.resolve(
        status
          ? {
              status,
              verified: !unverified.has(args.where.id),
              deletedAt: softDeleted.has(args.where.id) ? T0 : null,
            }
          : null,
      );
    }) as never);
    prisma.subscriptionPlan.findUnique.mockImplementation((() =>
      Promise.resolve(plan)) as never);
  });

  afterEach(() => jest.useRealTimers());

  const subscriptionQueries = () =>
    prisma.userSubscription.findUnique.mock.calls.map(
      ([args]) => args.where.authId,
    );

  describe('authentication', () => {
    it.each([
      ['no token', undefined],
      ['a malformed header', 'Token abc'],
      ['a garbage token', 'Bearer not-a-jwt'],
    ])('rejects %s with 401', async (_case, header) => {
      const req = request(app.getHttpServer()).get(ROUTE);
      await (header ? req.set('Authorization', header) : req).expect(401);
      expect(subscriptionQueries()).toHaveLength(0);
    });

    it('rejects a token signed with another secret', async () => {
      const current = config.jwt_access_secret;
      config.jwt_access_secret = 'another-secret';
      const forged = bearer('user-a');
      config.jwt_access_secret = current;

      await request(app.getHttpServer())
        .get(ROUTE)
        .set('Authorization', forged)
        .expect(401);
      expect(subscriptionQueries()).toHaveLength(0);
    });

    it('rejects an expired token', async () => {
      const expired = tokens.createAccessToken(
        { userId: 'user-a', role: UserRole.USER, tokenVersion: 1 },
        -1,
      );
      await request(app.getHttpServer())
        .get(ROUTE)
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);
    });

    it('rejects a revoked token (tokenVersion changed)', async () => {
      redis.get.mockResolvedValue(2 as never);
      await getAs('user-a').expect(401);
      expect(subscriptionQueries()).toHaveLength(0);
    });
  });

  describe('ownership', () => {
    beforeEach(() => {
      subscriptions.set(
        'user-a',
        row({ status: SubscriptionStatus.TRIAL, ...trialRow(8, 15) }),
      );
      subscriptions.set(
        'user-b',
        row({
          status: SubscriptionStatus.PRO,
          ...proRow(5, 35, BillingInterval.YEARLY),
        }),
      );
    });

    it('returns only the caller’s own subscription', async () => {
      const a = dataOf(await getAs('user-a').expect(200));
      const b = dataOf(await getAs('user-b').expect(200));

      expect(a).toMatchObject({
        status: 'TRIAL',
        pro: { billingInterval: null },
      });
      expect(b).toMatchObject({
        status: 'PRO',
        pro: { billingInterval: 'YEARLY' },
        trial: { startedAt: null },
      });
      expect(subscriptionQueries()).toEqual(['user-a', 'user-b']);
    });

    it.each(['?authId=user-b', '?userId=user-b', '?id=user-b&authId=user-b'])(
      'ignores attempts to select another user via %s',
      async (query) => {
        const data = dataOf(
          await getAs('user-a', `${ROUTE}${query}`).expect(200),
        );
        expect(data).toMatchObject({ status: 'TRIAL' });
        expect(subscriptionQueries()).toEqual(['user-a']);
      },
    );

    it('has no route for reading a subscription by user ID', async () => {
      await getAs('user-a', `${ROUTE}/user-b`).expect(404);
      expect(subscriptionQueries()).toHaveLength(0);
    });
  });

  describe('statuses', () => {
    it('returns FREE with full trial eligibility when the user has no record', async () => {
      const response = await getAs('user-a').expect(200);
      expect(response.body).toEqual({
        statusCode: 200,
        message: 'Success',
        data: {
          status: 'FREE',
          hasProAccess: false,
          accessSource: null,
          accessExpiresAt: null,
          trial: {
            eligible: true,
            ineligibleReason: null,
            used: false,
            active: false,
            startedAt: null,
            expiresAt: null,
          },
          pro: {
            active: false,
            billingInterval: null,
            startedAt: null,
            expiresAt: null,
            canceledAt: null,
          },
        },
      });
    });

    it('returns FREE for an existing but unused record', async () => {
      subscriptions.set('user-a', row());
      expect(dataOf(await getAs('user-a').expect(200))).toMatchObject({
        status: 'FREE',
        trial: { eligible: true },
      });
    });

    it('returns TRIAL with the trial dates during an active trial', async () => {
      subscriptions.set(
        'user-a',
        row({ status: SubscriptionStatus.TRIAL, ...trialRow(8, 15) }),
      );
      expect(dataOf(await getAs('user-a').expect(200))).toEqual({
        status: 'TRIAL',
        hasProAccess: true,
        accessSource: 'TRIAL',
        accessExpiresAt: at(15).toISOString(),
        trial: {
          eligible: false,
          ineligibleReason: 'TRIAL_ALREADY_USED',
          used: true,
          active: true,
          startedAt: at(8).toISOString(),
          expiresAt: at(15).toISOString(),
        },
        pro: {
          active: false,
          billingInterval: null,
          startedAt: null,
          expiresAt: null,
          canceledAt: null,
        },
      });
    });

    it.each([BillingInterval.MONTHLY, BillingInterval.YEARLY])(
      'returns PRO with the %s term dates during a paid term',
      async (interval) => {
        subscriptions.set(
          'user-a',
          row({ status: SubscriptionStatus.PRO, ...proRow(5, 35, interval) }),
        );
        expect(dataOf(await getAs('user-a').expect(200))).toMatchObject({
          status: 'PRO',
          hasProAccess: true,
          accessSource: 'PRO',
          accessExpiresAt: at(35).toISOString(),
          trial: {
            eligible: false,
            ineligibleReason: 'HAS_PRO_HISTORY',
            used: false,
          },
          pro: {
            active: true,
            billingInterval: interval,
            startedAt: at(5).toISOString(),
            expiresAt: at(35).toISOString(),
            canceledAt: null,
          },
        });
      },
    );

    it('returns PRO with the cancellation date for a canceled term that is still running', async () => {
      subscriptions.set(
        'user-a',
        row({
          status: SubscriptionStatus.PRO,
          ...proRow(5, 35),
          proCanceledAt: at(9),
        }),
      );
      expect(dataOf(await getAs('user-a').expect(200))).toMatchObject({
        status: 'PRO',
        hasProAccess: true,
        pro: { active: true, canceledAt: at(9).toISOString() },
      });
    });

    it('returns PRO when a paid term was bought after the trial', async () => {
      subscriptions.set(
        'user-a',
        row({
          status: SubscriptionStatus.PRO,
          ...trialRow(0, 7),
          ...proRow(7, 37),
        }),
      );
      expect(dataOf(await getAs('user-a').expect(200))).toMatchObject({
        status: 'PRO',
        trial: { used: true, active: false, startedAt: at(0).toISOString() },
        pro: { active: true },
      });
    });

    it.each([
      [
        'the trial expired',
        { status: SubscriptionStatus.EXPIRED, ...trialRow(0, 7) },
      ],
      [
        'the paid term expired',
        { status: SubscriptionStatus.EXPIRED, ...proRow(-30, 5) },
      ],
      [
        'a canceled term ran out',
        {
          status: SubscriptionStatus.EXPIRED,
          ...proRow(-30, 5),
          proCanceledAt: at(0),
        },
      ],
      [
        'both the trial and the paid term expired',
        {
          status: SubscriptionStatus.EXPIRED,
          ...trialRow(-40, -33),
          ...proRow(-33, 3),
        },
      ],
    ])('returns EXPIRED without access when %s', async (_case, overrides) => {
      subscriptions.set('user-a', row(overrides));
      expect(dataOf(await getAs('user-a').expect(200))).toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
        accessSource: null,
        accessExpiresAt: null,
        trial: { eligible: false, active: false },
        pro: { active: false },
      });
    });
  });

  describe('stored status is not trusted on its own', () => {
    it.each([
      ['TRIAL', { status: SubscriptionStatus.TRIAL, ...trialRow(0, 7) }],
      ['PRO', { status: SubscriptionStatus.PRO, ...proRow(-30, 5) }],
    ])(
      'reports EXPIRED for a stale stored %s whose window has passed, without rewriting it',
      async (_stored, overrides) => {
        subscriptions.set('user-a', row(overrides));
        expect(dataOf(await getAs('user-a').expect(200))).toMatchObject({
          status: 'EXPIRED',
          hasProAccess: false,
        });
        expect(prisma.userSubscription.update.mock.calls).toHaveLength(0);
        expect(prisma.userSubscription.updateMany.mock.calls).toHaveLength(0);
        expect(prisma.userSubscription.upsert.mock.calls).toHaveLength(0);
      },
    );
  });

  describe('exact expiration edges', () => {
    const statusAt = async (now: Date) => {
      freezeTime(now);
      return dataOf(await getAs('user-a').expect(200));
    };

    it('keeps the trial active until the last millisecond and expires it at the exact expiry instant', async () => {
      subscriptions.set(
        'user-a',
        row({ status: SubscriptionStatus.TRIAL, ...trialRow(3, 10) }),
      );

      expect(await statusAt(at(3))).toMatchObject({
        status: 'TRIAL',
        hasProAccess: true,
      });
      expect(await statusAt(at(10, -1))).toMatchObject({
        status: 'TRIAL',
        hasProAccess: true,
      });
      expect(await statusAt(at(10))).toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
        trial: {
          active: false,
          startedAt: at(3).toISOString(),
          expiresAt: at(10).toISOString(),
        },
      });
    });

    it('keeps a paid term active until the last millisecond and expires it at the exact expiry instant', async () => {
      subscriptions.set(
        'user-a',
        row({
          status: SubscriptionStatus.PRO,
          ...proRow(5, 35),
          proCanceledAt: at(6),
        }),
      );

      expect(await statusAt(at(35, -1))).toMatchObject({
        status: 'PRO',
        hasProAccess: true,
      });
      expect(await statusAt(at(35))).toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
      });
    });

    it('does not grant access before a window starts', async () => {
      subscriptions.set(
        'user-a',
        row({ status: SubscriptionStatus.PRO, ...proRow(20, 50) }),
      );
      expect(await statusAt(at(20, -1))).toMatchObject({ hasProAccess: false });
      expect(await statusAt(at(20))).toMatchObject({
        status: 'PRO',
        hasProAccess: true,
      });
    });

    it('moves from TRIAL to PRO at the trial expiry when a paid term follows', async () => {
      subscriptions.set(
        'user-a',
        row({
          status: SubscriptionStatus.PRO,
          ...trialRow(3, 10),
          ...proRow(10, 40),
        }),
      );
      expect(await statusAt(at(10, -1))).toMatchObject({ status: 'TRIAL' });
      expect(await statusAt(at(10))).toMatchObject({ status: 'PRO' });
    });
  });

  describe('trial eligibility', () => {
    it.each([
      [{ trialEnabled: false }, 'TRIAL_DISABLED'],
      [{ planEnabled: false }, 'PLAN_DISABLED'],
    ])('reports the trial as unavailable when %p', async (settings, reason) => {
      plan = {
        planEnabled: true,
        trialEnabled: true,
        trialDays: 7,
        monthlyPriceUsdCents: 1900,
        yearlyPriceUsdCents: 19000,
        updatedAt: T0,
        ...settings,
      };
      expect(dataOf(await getAs('user-a').expect(200))).toMatchObject({
        status: 'FREE',
        trial: { eligible: false, ineligibleReason: reason },
      });
    });

    it.each([
      ['unverified', () => unverified.add('user-a')],
      ['soft-deleted', () => softDeleted.add('user-a')],
    ])(
      'reports an ACTIVE but %s account as ineligible, matching activation',
      async (_case, arrange) => {
        arrange();
        expect(dataOf(await getAs('user-a').expect(200))).toMatchObject({
          trial: { eligible: false, ineligibleReason: 'ACCOUNT_INACTIVE' },
        });
      },
    );

    it('reports an inactive account as ineligible, matching activation', async () => {
      accountStatus.set('user-a', 'SUSPENDED');
      expect(dataOf(await getAs('user-a').expect(200))).toMatchObject({
        trial: { eligible: false, ineligibleReason: 'ACCOUNT_INACTIVE' },
      });
    });
  });
});
