import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BillingInterval } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { UserRole } from '../auth/interfaces/auth.interface';
import { AuthUtilsService } from '../auth/services/auth-utils.service';
import config from '../common/config/app.config';
import AppError from '../common/errors/app.error';
import { AllExceptionsFilter } from '../common/filters/all-exception.filter';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import { RedisService } from '../common/services/redis.service';
import { CheckoutService } from './checkout.service';
import { SubscriptionTrialService } from './subscription-trial.service';
import { SubscriptionModule } from './subscription.module';

const redis = mock<RedisService>();
const checkout = mock<CheckoutService>();
const trials = mock<SubscriptionTrialService>();

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: mockDeep<PrismaService>() },
    { provide: CustomLoggerService, useValue: mock<CustomLoggerService>() },
  ],
  exports: [PrismaService, CustomLoggerService],
})
class TestInfrastructureModule {}

const ROUTE = '/v1/subscription/checkout';

describe('POST /v1/subscription/checkout (HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  const tokens = new AuthUtilsService(mock<RedisService>());
  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;

  const view = {
    billingInterval: BillingInterval.MONTHLY,
    amountCents: 1900,
    currency: 'USD',
    url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    expiresAt: '2026-03-02T09:30:00.000Z',
    reused: false,
  };

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'stripe-checkout-controller-spec-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, SubscriptionModule],
    })
      .overrideProvider(RedisService)
      .useValue(redis)
      .overrideProvider(SubscriptionTrialService)
      .useValue(trials)
      .overrideProvider(CheckoutService)
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
    redis.get.mockResolvedValue(1 as never);
    checkout.startCheckout.mockResolvedValue(view);
  });

  it('rejects a request without a token', async () => {
    await request(app.getHttpServer())
      .post(ROUTE)
      .send({ billingInterval: 'MONTHLY' })
      .expect(401);
    expect(checkout.startCheckout.mock.calls).toHaveLength(0);
  });

  it('starts a checkout for the token’s user and returns the standard envelope', async () => {
    const response = await request(app.getHttpServer())
      .post(ROUTE)
      .set('Authorization', bearer('user-1'))
      .set('User-Agent', 'checkout-spec')
      .send({ billingInterval: 'MONTHLY' })
      .expect(201);

    expect(response.body).toEqual({
      statusCode: 201,
      message: 'Success',
      data: view,
    });
    expect(checkout.startCheckout.mock.calls).toEqual([
      [
        'user-1',
        'MONTHLY',
        expect.objectContaining({ userAgent: 'checkout-spec' }),
      ],
    ]);
  });

  it('takes the user only from the token, never from the request body', async () => {
    await request(app.getHttpServer())
      .post(ROUTE)
      .set('Authorization', bearer('user-1'))
      .send({ billingInterval: 'YEARLY' })
      .expect(201);
    expect(checkout.startCheckout.mock.calls[0]?.[0]).toBe('user-1');
    expect(checkout.startCheckout.mock.calls[0]?.[1]).toBe('YEARLY');
  });

  it('rejects a body with an unrecognized field instead of silently ignoring it', async () => {
    await request(app.getHttpServer())
      .post(ROUTE)
      .set('Authorization', bearer('user-1'))
      .send({ billingInterval: 'MONTHLY', authId: 'someone-else' })
      .expect(400);
    expect(checkout.startCheckout.mock.calls).toHaveLength(0);
  });

  it.each([
    [{}, 'billingInterval should not be empty'],
    [
      { billingInterval: 'WEEKLY' },
      'billingInterval must be one of the following values',
    ],
  ])('rejects an invalid body %p with 400', async (body) => {
    await request(app.getHttpServer())
      .post(ROUTE)
      .set('Authorization', bearer('user-1'))
      .send(body)
      .expect(400);
    expect(checkout.startCheckout.mock.calls).toHaveLength(0);
  });

  it.each([
    [AppError.conflict('An active Pro subscription is already in place'), 409],
    [
      AppError.conflict(
        'A checkout request is already being processed. Please try again in a moment.',
      ),
      409,
    ],
    [AppError.forbidden('Only active accounts can start checkout'), 403],
  ])('returns the service rejection %#', async (error, status) => {
    checkout.startCheckout.mockRejectedValue(error);
    const response = await request(app.getHttpServer())
      .post(ROUTE)
      .set('Authorization', bearer('user-1'))
      .send({ billingInterval: 'MONTHLY' })
      .expect(status);
    expect(response.body).toMatchObject({
      success: false,
      statusCode: status,
      message: error.message,
    });
  });
});
