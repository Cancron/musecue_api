import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
import { RateLimitStore } from '../infrastructure/rate-limit/rate-limit.store';
import { TokenVersionCache } from '../infrastructure/token-version/token-version.cache';
import type {
  BillingInfoView,
  PaymentHistoryView,
} from './interfaces/billing.interface';
import { SubscriptionBillingService } from './subscription-billing.service';
import { SubscriptionModule } from './subscription.module';

const tokenVersions = mock<TokenVersionCache>();
const billing = mock<SubscriptionBillingService>();

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: mockDeep<PrismaService>() },
    { provide: CustomLoggerService, useValue: mock<CustomLoggerService>() },
    { provide: TokenVersionCache, useValue: tokenVersions },
  ],
  exports: [PrismaService, CustomLoggerService, TokenVersionCache],
})
class TestInfrastructureModule {}

describe('GET /v1/subscription/billing and /payments (HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  const tokens = new AuthUtilsService(mock<RateLimitStore>());
  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;

  const info: BillingInfoView = {
    status: 'PRO',
    hasProAccess: true,
    accessExpiresAt: '2026-12-01T10:00:00.000Z',
    subscriptionState: 'ACTIVE',
    plan: {
      code: 'PRO',
      billingInterval: 'MONTHLY',
      priceCents: 1900,
      currency: 'USD',
    },
    currentPeriod: {
      start: '2026-11-01T10:00:00.000Z',
      end: '2026-12-01T10:00:00.000Z',
    },
    autoRenew: true,
    nextRenewalAt: '2026-12-01T10:00:00.000Z',
    canceledAt: null,
    pastDueSince: null,
  };
  const history: PaymentHistoryView = {
    items: [],
    meta: {
      page: 2,
      limit: 5,
      total: 0,
      totalPages: 0,
      hasPreviousPage: true,
      hasNextPage: false,
    },
  };

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'subscription-billing-http-spec-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, SubscriptionModule],
    })
      .overrideProvider(SubscriptionBillingService)
      .useValue(billing)
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
    tokenVersions.get.mockResolvedValue(1);
    billing.getBilling.mockResolvedValue(info);
    billing.getPaymentHistory.mockResolvedValue(history);
  });

  const get = (path: string, userId: string | null = 'user-1') => {
    const call = request(app.getHttpServer()).get(path);
    if (userId) call.set('Authorization', bearer(userId));
    return call;
  };

  it.each(['/v1/subscription/billing', '/v1/subscription/payments'])(
    'rejects %s without a valid bearer token',
    async (path) => {
      await get(path, null).expect(401);
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer forged')
        .expect(401);
      expect(billing.getBilling.mock.calls).toHaveLength(0);
      expect(billing.getPaymentHistory.mock.calls).toHaveLength(0);
    },
  );

  it('returns the token user’s billing information in the envelope', async () => {
    const response = await get('/v1/subscription/billing').expect(200);
    expect(response.body).toEqual({
      statusCode: 200,
      message: 'Success',
      data: info,
    });
    expect(billing.getBilling.mock.calls).toEqual([['user-1']]);
  });

  it('returns the token user’s payment history with numeric paging', async () => {
    const response = await get(
      '/v1/subscription/payments?page=2&limit=5',
    ).expect(200);
    expect(response.body).toEqual({
      statusCode: 200,
      message: 'Success',
      data: history,
    });
    expect(billing.getPaymentHistory.mock.calls).toEqual([
      ['user-1', { page: 2, limit: 5 }],
    ]);
  });

  it.each([
    ['another user', '?userId=user-2'],
    ['another auth id', '?authId=user-2'],
    ['a customer id', '?customerId=cus_123'],
    ['a subscription id', '?subscriptionId=sub_123'],
    ['a page of 0', '?page=0'],
    ['a fractional page', '?page=1.5'],
    ['a non-numeric limit', '?limit=all'],
    ['a limit above 100', '?limit=101'],
    ['a limit of 0', '?limit=0'],
  ])('rejects %s in the payment history query with 400', async (_l, query) => {
    await get(`/v1/subscription/payments${query}`).expect(400);
    expect(billing.getPaymentHistory.mock.calls).toHaveLength(0);
  });

  it('never takes the user of billing information from the request', async () => {
    await get('/v1/subscription/billing?userId=user-2')
      .send({ userId: 'user-2' })
      .expect(200);
    expect(billing.getBilling.mock.calls).toEqual([['user-1']]);
  });

  it('has no routes to read or change another user’s payments', async () => {
    await get('/v1/subscription/payments/some-payment-id').expect(404);
    await get('/v1/users/user-2/payments').expect(404);
    await request(app.getHttpServer())
      .patch('/v1/subscription/payments')
      .set('Authorization', bearer('user-1'))
      .expect(404);
    await request(app.getHttpServer())
      .delete('/v1/subscription/billing')
      .set('Authorization', bearer('user-1'))
      .expect(404);
  });
});
