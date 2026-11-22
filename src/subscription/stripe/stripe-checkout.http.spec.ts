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
import { UserRole } from '../../auth/interfaces/auth.interface';
import { AuthUtilsService } from '../../auth/services/auth-utils.service';
import config from '../../common/config/app.config';
import { AllExceptionsFilter } from '../../common/filters/all-exception.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RateLimitStore } from '../../infrastructure/rate-limit/rate-limit.store';
import { TokenVersionCache } from '../../infrastructure/token-version/token-version.cache';
import type { CheckoutSessionView } from '../interfaces/checkout.interface';
import { SubscriptionModule } from '../subscription.module';
import {
  CHECKOUT_ERRORS,
  StripeCheckoutService,
} from './stripe-checkout.service';

const tokenVersions = mock<TokenVersionCache>();
const checkout = mock<StripeCheckoutService>();

// SubscriptionModule imports CreditsModule, which stores the default credit
// settings at startup (insert unless present).
const prismaWithSeededCredits = () => {
  const prisma = mockDeep<PrismaService>();
  prisma.creditSettings.createMany.mockResolvedValue({ count: 0 });
  return prisma;
};

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prismaWithSeededCredits() },
    { provide: CustomLoggerService, useValue: mock<CustomLoggerService>() },
    { provide: TokenVersionCache, useValue: tokenVersions },
  ],
  exports: [PrismaService, CustomLoggerService, TokenVersionCache],
})
class TestInfrastructureModule {}

const ROUTE = '/v1/subscription/checkout';

describe('POST /v1/subscription/checkout (Stripe checkout HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  const tokens = new AuthUtilsService(mock<RateLimitStore>());
  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;

  const view: CheckoutSessionView = {
    checkoutSessionId: 'checkout-1',
    provider: 'stripe',
    status: 'OPEN',
    billingInterval: 'MONTHLY',
    amountCents: 1900,
    discount: null,
    amountDueCents: 1900,
    currency: 'USD',
    url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    expiresAt: '2026-03-01T10:30:00.000Z',
    reused: false,
  };

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'stripe-checkout-http-spec-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, SubscriptionModule],
    })
      .overrideProvider(StripeCheckoutService)
      .useValue(checkout)
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
    checkout.createCheckout.mockResolvedValue(view);
  });

  const post = (body: unknown, userId: string | null = 'user-1') => {
    const call = request(app.getHttpServer()).post(ROUTE);
    if (userId) call.set('Authorization', bearer(userId));
    return call.send(body as object);
  };

  it('requires a bearer token', async () => {
    await post({ billingInterval: 'MONTHLY' }, null).expect(401);
    await request(app.getHttpServer())
      .post(ROUTE)
      .set('Authorization', 'Bearer not-a-jwt')
      .send({ billingInterval: 'MONTHLY' })
      .expect(401);
    expect(checkout.createCheckout.mock.calls).toHaveLength(0);
  });

  it.each(['MONTHLY', 'YEARLY'])(
    'starts a %s checkout for the token user and returns the standard envelope',
    async (billingInterval) => {
      const response = await post({ billingInterval }).expect(201);

      expect(response.body).toEqual({
        statusCode: 201,
        message: 'Success',
        data: view,
      });
      expect(checkout.createCheckout.mock.calls).toEqual([
        ['user-1', billingInterval, expect.any(Date), { discountCode: null }],
      ]);
    },
  );

  it.each([
    ['a missing body', undefined],
    ['an empty body', {}],
    ['a null option', { billingInterval: null }],
    ['a lowercase option', { billingInterval: 'monthly' }],
    ['an unknown option', { billingInterval: 'WEEKLY' }],
    ['a numeric option', { billingInterval: 1 }],
    ['an array', { billingInterval: ['MONTHLY'] }],
    ['a client-supplied price', { billingInterval: 'MONTHLY', amountCents: 1 }],
    [
      'a client-supplied currency',
      { billingInterval: 'MONTHLY', currency: 'EUR' },
    ],
    ['another user id', { billingInterval: 'MONTHLY', userId: 'user-2' }],
    ['a Stripe price id', { billingInterval: 'MONTHLY', priceId: 'price_123' }],
    [
      'a client payment confirmation',
      { billingInterval: 'MONTHLY', paid: true },
    ],
  ])('rejects %s with 400', async (_label, body) => {
    await post(body).expect(400);
    expect(checkout.createCheckout.mock.calls).toHaveLength(0);
  });

  it.each([
    [CHECKOUT_ERRORS.alreadySubscribed(), 409],
    [CHECKOUT_ERRORS.paymentProcessing(), 409],
    [CHECKOUT_ERRORS.accountInactive(), 403],
    [CHECKOUT_ERRORS.planUnavailable(), 403],
    [CHECKOUT_ERRORS.notConfigured(), 503],
    [CHECKOUT_ERRORS.providerUnavailable(), 503],
  ])('returns the service rejection %#', async (error, status) => {
    checkout.createCheckout.mockRejectedValue(error);
    const response = await post({ billingInterval: 'YEARLY' }).expect(status);
    expect(response.body).toMatchObject({
      success: false,
      statusCode: status,
      message: error.message,
    });
  });
});
