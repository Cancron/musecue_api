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
import AppError from '../common/errors/app.error';
import { AllExceptionsFilter } from '../common/filters/all-exception.filter';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import { RedisService } from '../common/services/redis.service';
import { SubscriptionTrialService } from './subscription-trial.service';
import { SubscriptionModule } from './subscription.module';

const redis = mock<RedisService>();
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

const ROUTE = '/v1/subscription/trial';

describe('POST /v1/subscription/trial (HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  const tokens = new AuthUtilsService(mock<RedisService>());
  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;

  const activation = {
    status: 'TRIAL' as const,
    hasProAccess: true,
    accessSource: 'TRIAL' as const,
    accessExpiresAt: '2026-03-08T09:30:00.000Z',
    trialStartedAt: '2026-03-01T09:30:00.000Z',
    trialExpiresAt: '2026-03-08T09:30:00.000Z',
  };

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'subscription-controller-spec-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, SubscriptionModule],
    })
      .overrideProvider(RedisService)
      .useValue(redis)
      .overrideProvider(SubscriptionTrialService)
      .useValue(trials)
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
    trials.activateTrial.mockResolvedValue(activation);
  });

  it('rejects a request without a token', async () => {
    await request(app.getHttpServer()).post(ROUTE).expect(401);
    expect(trials.activateTrial.mock.calls).toHaveLength(0);
  });

  it('activates the trial for the token’s user and returns the standard envelope', async () => {
    const response = await request(app.getHttpServer())
      .post(ROUTE)
      .set('Authorization', bearer('user-1'))
      .set('User-Agent', 'trial-spec')
      .expect(201);

    expect(response.body).toEqual({
      statusCode: 201,
      message: 'Success',
      data: activation,
    });
    expect(trials.activateTrial.mock.calls).toEqual([
      ['user-1', expect.objectContaining({ userAgent: 'trial-spec' })],
    ]);
  });

  it('never takes the user from the request body', async () => {
    await request(app.getHttpServer())
      .post(ROUTE)
      .set('Authorization', bearer('user-1'))
      .send({ authId: 'someone-else', userId: 'someone-else' })
      .expect(201);
    expect(trials.activateTrial.mock.calls[0]?.[0]).toBe('user-1');
  });

  it.each([
    [AppError.forbidden('Only active accounts can start a free trial'), 403],
    [AppError.forbidden('The free trial is not currently available'), 403],
    [AppError.conflict('The free trial has already been used'), 409],
  ])('returns the service rejection %#', async (error, status) => {
    trials.activateTrial.mockRejectedValue(error);
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
