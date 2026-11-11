import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PlanCode, type SubscriptionPlan } from '@prisma/client';
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

const ROUTE = '/v1/admin/subscription-plan';

/** The `data` member of the response envelope. */
const dataOf = (response: { body: unknown }) =>
  (response.body as { data: unknown }).data;

describe('Subscription plan administration (HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  let stored: SubscriptionPlan | null;
  const updatedAt = new Date('2026-09-12T12:00:00.000Z');
  const tokens = new AuthUtilsService(mock<RedisService>());

  /** A token minted by the unchanged production token code. */
  const bearer = (role: UserRole, userId = 'user-id') =>
    `Bearer ${tokens.createAccessToken({ userId, role, tokenVersion: 1 })}`;

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'subscription-plan-spec-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, SubscriptionModule],
    })
      .overrideProvider(RedisService)
      .useValue(redis)
      .compile();

    app = moduleRef.createNestApplication();
    const logger = mock<Logger>();
    // Mirror the global setup in main.ts.
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
    stored = null;
    redis.get.mockResolvedValue(1 as never); // cached tokenVersion
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    // An in-memory stand-in for the single plan row.
    prisma.subscriptionPlan.findUnique.mockImplementation((() =>
      Promise.resolve(stored)) as never);
    prisma.subscriptionPlan.upsert.mockImplementation(((args: {
      create: Partial<SubscriptionPlan>;
      update: Partial<SubscriptionPlan>;
    }) => {
      stored = stored
        ? { ...stored, ...args.update, updatedAt }
        : {
            code: PlanCode.PRO,
            planEnabled: true,
            monthlyPriceUsdCents: 1900,
            yearlyPriceUsdCents: 19000,
            trialEnabled: true,
            trialDays: 7,
            createdAt: updatedAt,
            updatedAt,
            ...args.create,
          };
      return Promise.resolve(stored);
    }) as never);
  });

  const get = (auth?: string) => {
    const req = request(app.getHttpServer()).get(ROUTE);
    return auth ? req.set('Authorization', auth) : req;
  };
  const patch = (body: unknown, auth = bearer(UserRole.ADMIN, 'admin-id')) =>
    request(app.getHttpServer())
      .patch(ROUTE)
      .set('Authorization', auth)
      .set('User-Agent', 'plan-spec')
      .send(body as object);

  describe('permission control', () => {
    it('rejects requests without a token', async () => {
      await get().expect(401);
      await request(app.getHttpServer())
        .patch(ROUTE)
        .send({ trialDays: 3 })
        .expect(401);
      expect(prisma.subscriptionPlan.upsert.mock.calls).toHaveLength(0);
    });

    it('rejects a token signed with another secret', async () => {
      const current = config.jwt_access_secret;
      config.jwt_access_secret = 'another-secret';
      const forged = bearer(UserRole.SUPERADMIN);
      config.jwt_access_secret = current;

      await patch({ trialDays: 3 }, forged).expect(401);
      expect(prisma.subscriptionPlan.upsert.mock.calls).toHaveLength(0);
    });

    it.each([UserRole.USER, UserRole.MODERATOR])(
      'forbids a %s from reading or changing the plan',
      async (role) => {
        await get(bearer(role)).expect(403);
        await patch({ planEnabled: false }, bearer(role)).expect(403);
        expect(prisma.subscriptionPlan.upsert.mock.calls).toHaveLength(0);
        expect(prisma.activityLogEvent.create.mock.calls).toHaveLength(0);
      },
    );

    it.each([UserRole.ADMIN, UserRole.SUPERADMIN])(
      'lets a %s read and change the plan',
      async (role) => {
        await get(bearer(role)).expect(200);
        await patch({ monthlyPriceUsdCents: 2100 }, bearer(role)).expect(200);
        expect(prisma.subscriptionPlan.upsert.mock.calls).toHaveLength(1);
      },
    );

    it('authorizes from the verified token without a database role lookup', async () => {
      await patch({ trialDays: 10 }, bearer(UserRole.SUPERADMIN)).expect(200);
      expect(prisma.authUser.findUnique.mock.calls).toHaveLength(0);
      expect(prisma.authUser.findFirst.mock.calls).toHaveLength(0);
    });

    it('records the acting administrator', async () => {
      await patch({ trialDays: 10 }, bearer(UserRole.ADMIN, 'admin-42')).expect(
        200,
      );
      expect(prisma.activityLogEvent.create.mock.calls[0]?.[0].data).toEqual(
        expect.objectContaining({
          tableName: 'SubscriptionPlan',
          recordId: 'PRO',
          actionedBy: 'admin-42',
          userAgent: 'plan-spec',
        }),
      );
    });
  });

  describe('default values', () => {
    it('serves the defaults in the standard envelope before anything is saved', async () => {
      const response = await get(bearer(UserRole.ADMIN)).expect(200);
      expect(response.body).toEqual({
        statusCode: 200,
        message: 'Success',
        data: {
          code: 'PRO',
          currency: 'USD',
          planEnabled: true,
          monthlyPriceUsdCents: 1900,
          yearlyPriceUsdCents: 19000,
          trialEnabled: true,
          trialDays: 7,
          updatedAt: null,
        },
      });
    });
  });

  describe('partial updates and enable/disable', () => {
    it('changes only the supplied fields across successive requests', async () => {
      await patch({ monthlyPriceUsdCents: 2400 }).expect(200);
      await patch({ yearlyPriceUsdCents: 24000 }).expect(200);
      const response = await patch({ trialDays: 30 }).expect(200);

      expect(dataOf(response)).toEqual({
        code: 'PRO',
        currency: 'USD',
        planEnabled: true,
        monthlyPriceUsdCents: 2400,
        yearlyPriceUsdCents: 24000,
        trialEnabled: true,
        trialDays: 30,
        updatedAt: updatedAt.toISOString(),
      });
    });

    it('disables and re-enables the trial without losing its length', async () => {
      await patch({ trialDays: 14 }).expect(200);

      const disabled = await patch({ trialEnabled: false }).expect(200);
      expect(dataOf(disabled)).toMatchObject({
        trialEnabled: false,
        trialDays: 14,
      });

      const enabled = await patch({ trialEnabled: true }).expect(200);
      expect(dataOf(enabled)).toMatchObject({
        trialEnabled: true,
        trialDays: 14,
      });
    });

    it('disables and re-enables the plan without losing its prices', async () => {
      await patch({ monthlyPriceUsdCents: 2900 }).expect(200);

      const disabled = await patch({ planEnabled: false }).expect(200);
      expect(dataOf(disabled)).toMatchObject({
        planEnabled: false,
        monthlyPriceUsdCents: 2900,
        yearlyPriceUsdCents: 19000,
      });

      const enabled = await patch({ planEnabled: true }).expect(200);
      expect(dataOf(enabled)).toMatchObject({
        planEnabled: true,
        monthlyPriceUsdCents: 2900,
      });
    });

    it('accepts every field in one request', async () => {
      const all = {
        planEnabled: false,
        monthlyPriceUsdCents: 999,
        yearlyPriceUsdCents: 9999,
        trialEnabled: false,
        trialDays: 3,
      };
      const response = await patch(all).expect(200);
      expect(dataOf(response)).toMatchObject(all);
    });
  });

  describe('validation', () => {
    it.each([
      ['an empty body', {}],
      ['a fractional monthly price', { monthlyPriceUsdCents: 19.99 }],
      ['a string monthly price', { monthlyPriceUsdCents: '1900' }],
      ['a zero monthly price', { monthlyPriceUsdCents: 0 }],
      ['a negative yearly price', { yearlyPriceUsdCents: -1 }],
      ['a yearly price above $9,999.99', { yearlyPriceUsdCents: 1_000_000 }],
      ['a null yearly price', { yearlyPriceUsdCents: null }],
      ['a zero-day trial', { trialDays: 0 }],
      ['a trial longer than 365 days', { trialDays: 366 }],
      ['a fractional trial', { trialDays: 1.5 }],
      ['a null trial', { trialDays: null }],
      ['a string boolean for planEnabled', { planEnabled: 'false' }],
      ['a numeric boolean for trialEnabled', { trialEnabled: 0 }],
      ['a null planEnabled', { planEnabled: null }],
      ['the removed priceUsdCents field', { priceUsdCents: 1900 }],
      ['an unknown field', { trialDays: 7, currency: 'EUR' }],
    ])('rejects %s with 400 and persists nothing', async (_case, body) => {
      const response = await patch(body).expect(400);
      expect(response.body).toMatchObject({ success: false, statusCode: 400 });
      expect(prisma.subscriptionPlan.upsert.mock.calls).toHaveLength(0);
      expect(prisma.activityLogEvent.create.mock.calls).toHaveLength(0);
    });

    it.each([
      [
        'the minimum price',
        { monthlyPriceUsdCents: 1, yearlyPriceUsdCents: 1 },
      ],
      [
        'the maximum price',
        { monthlyPriceUsdCents: 999_999, yearlyPriceUsdCents: 999_999 },
      ],
      ['the minimum trial', { trialDays: 1 }],
      ['the maximum trial', { trialDays: 365 }],
    ])('accepts %s', async (_case, body) => {
      await patch(body).expect(200);
      expect(prisma.subscriptionPlan.upsert.mock.calls).toHaveLength(1);
    });
  });
});
