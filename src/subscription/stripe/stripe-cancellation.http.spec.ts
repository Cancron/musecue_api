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
import type { SubscriptionCancellationView } from '../interfaces/cancellation.interface';
import { SubscriptionModule } from '../subscription.module';
import {
  CANCELLATION_ERRORS,
  StripeCancellationService,
} from './stripe-cancellation.service';
import { StepUpGuard } from '../../auth/step-up/step-up.guard';
import { stepUpSatisfied } from '../../../test/support/step-up-satisfied';

const tokenVersions = mock<TokenVersionCache>();
const cancellation = mock<StripeCancellationService>();

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

const ROUTE = '/v1/subscription/cancel';

describe('POST /v1/subscription/cancel (HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  const tokens = new AuthUtilsService(mock<RateLimitStore>());
  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;

  const view: SubscriptionCancellationView = {
    status: 'PRO',
    hasProAccess: true,
    autoRenew: false,
    canceledAt: '2026-03-10T09:00:00.000Z',
    endsAt: '2026-03-31T10:00:00.000Z',
    accessExpiresAt: '2026-03-31T10:00:00.000Z',
    alreadyCanceled: false,
  };

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'stripe-cancellation-http-spec-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, SubscriptionModule],
    })
      .overrideProvider(StripeCancellationService)
      .useValue(cancellation)
      .overrideGuard(StepUpGuard)
      .useValue(stepUpSatisfied)
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
    cancellation.cancelAtPeriodEnd.mockResolvedValue(view);
  });

  it('requires a bearer token', async () => {
    await request(app.getHttpServer()).post(ROUTE).expect(401);
    await request(app.getHttpServer())
      .post(ROUTE)
      .set('Authorization', 'Bearer forged')
      .expect(401);
    expect(cancellation.cancelAtPeriodEnd.mock.calls).toHaveLength(0);
  });

  it('cancels the token user’s subscription and returns 200 with the envelope', async () => {
    const response = await request(app.getHttpServer())
      .post(ROUTE)
      .set('Authorization', bearer('user-1'))
      .set('User-Agent', 'cancel-http-spec')
      .expect(200);

    expect(response.body).toEqual({
      statusCode: 200,
      message: 'Success',
      data: view,
    });
    expect(cancellation.cancelAtPeriodEnd.mock.calls).toEqual([
      ['user-1', expect.objectContaining({ userAgent: 'cancel-http-spec' })],
    ]);
  });

  it('never takes the user or subscription from the request', async () => {
    await request(app.getHttpServer())
      .post(`${ROUTE}?userId=user-2&subscriptionId=sub_victim`)
      .set('Authorization', bearer('user-1'))
      .send({
        userId: 'user-2',
        authId: 'user-2',
        subscriptionId: 'sub_victim',
        providerSubscriptionId: 'sub_victim',
      })
      .expect(200);

    expect(cancellation.cancelAtPeriodEnd.mock.calls).toHaveLength(1);
    expect(cancellation.cancelAtPeriodEnd.mock.calls[0]?.[0]).toBe('user-1');
  });

  it.each([
    [CANCELLATION_ERRORS.noActiveSubscription(), 409],
    [CANCELLATION_ERRORS.changed(), 409],
    [CANCELLATION_ERRORS.failed(), 503],
    [CANCELLATION_ERRORS.notConfigured(), 503],
  ])('returns the service rejection %#', async (error, status) => {
    cancellation.cancelAtPeriodEnd.mockRejectedValue(error);
    const response = await request(app.getHttpServer())
      .post(ROUTE)
      .set('Authorization', bearer('user-1'))
      .expect(status);
    expect(response.body).toMatchObject({
      success: false,
      statusCode: status,
      message: error.message,
    });
  });
});
