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
import {
  BillingInterval,
  SubscriptionStatus,
  type UserSubscription,
} from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { freezeTime } from '../../test/support/freeze-time';
import { UserRole } from '../auth/interfaces/auth.interface';
import { AuthUtilsService } from '../auth/services/auth-utils.service';
import config from '../common/config/app.config';
import { AllExceptionsFilter } from '../common/filters/all-exception.filter';
import { AuthGuard } from '../common/guards/auth.guard';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { PrismaService } from '../common/services/prisma.service';
import { RedisService } from '../common/services/redis.service';
import { ProAccessGuard, type ProAccessRequest } from './pro-access.guard';
import { SubscriptionModule } from './subscription.module';

const prisma = mockDeep<PrismaService>();
const redis = mock<RedisService>();
const proHandler = jest.fn();

/** A stand-in feature module, wired the way a real Pro feature would be. */
@UseGuards(AuthGuard)
@Controller('v1/test-features')
class FeatureTestController {
  @Get('basic')
  basic() {
    return { feature: 'basic' };
  }

  @UseGuards(ProAccessGuard)
  @Get('pro')
  pro(@Req() req: ProAccessRequest) {
    proHandler(req.proAccess);
    return { feature: 'pro', accessSource: req.proAccess.accessSource };
  }
}

@Module({
  imports: [SubscriptionModule],
  controllers: [FeatureTestController],
  providers: [AuthGuard, RedisService],
})
class FeatureTestModule {}

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: CustomLoggerService, useValue: mock<CustomLoggerService>() },
  ],
  exports: [PrismaService, CustomLoggerService],
})
class TestInfrastructureModule {}

type Row = Omit<UserSubscription, 'id' | 'authId' | 'createdAt' | 'updatedAt'>;
const T0 = new Date('2026-03-01T00:00:00.000Z');
const at = (days: number, ms = 0) =>
  new Date(T0.getTime() + days * 86_400_000 + ms);
const row = (overrides: Partial<Row>): Row => ({
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

describe('Pro feature endpoints behind ProAccessGuard (HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  let subscriptions: Map<string, Row>;
  const tokens = new AuthUtilsService(mock<RedisService>());

  const call = (path: string, userId?: string, now: Date = at(10)) => {
    freezeTime(now);
    const req = request(app.getHttpServer()).get(`/v1/test-features/${path}`);
    return userId
      ? req.set(
          'Authorization',
          `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`,
        )
      : req;
  };

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'pro-access-spec-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, FeatureTestModule],
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
    subscriptions = new Map([
      [
        'trial-user',
        row({
          status: 'TRIAL',
          trialUsed: true,
          trialStartedAt: at(5),
          trialExpiresAt: at(12),
        }),
      ],
      [
        'pro-user',
        row({
          status: 'PRO',
          billingInterval: BillingInterval.YEARLY,
          proStartedAt: at(5),
          proExpiresAt: at(370),
        }),
      ],
      [
        'lapsed-user',
        row({
          status: 'EXPIRED',
          billingInterval: BillingInterval.MONTHLY,
          proStartedAt: at(-30),
          proExpiresAt: at(0),
        }),
      ],
    ]);
    redis.get.mockResolvedValue(1 as never);
    prisma.userSubscription.findUnique.mockImplementation(((args: {
      where: { authId: string };
    }) =>
      Promise.resolve(subscriptions.get(args.where.authId) ?? null)) as never);
  });

  afterEach(() => jest.useRealTimers());

  it('authenticates before checking the subscription', async () => {
    await call('pro').expect(401);
    expect(prisma.userSubscription.findUnique.mock.calls).toHaveLength(0);
    expect(proHandler).not.toHaveBeenCalled();
  });

  it('denies a user without a subscription with 403 in the standard error format, without running the handler', async () => {
    const response = await call('pro', 'new-user').expect(403);
    expect(response.body).toMatchObject({
      success: false,
      statusCode: 403,
      message: 'An active Pro subscription or free trial is required',
    });
    expect(proHandler).not.toHaveBeenCalled();
  });

  it('lets an active trial through and hands the decision to the handler', async () => {
    const response = await call('pro', 'trial-user').expect(200);
    expect(response.body).toEqual({
      statusCode: 200,
      message: 'Success',
      data: { feature: 'pro', accessSource: 'TRIAL' },
    });
    expect(proHandler).toHaveBeenCalledWith({
      status: 'TRIAL',
      hasProAccess: true,
      accessSource: 'TRIAL',
      accessExpiresAt: at(12),
    });
  });

  it('denies the trial user from the exact expiry instant', async () => {
    await call('pro', 'trial-user', at(12, -1)).expect(200);
    await call('pro', 'trial-user', at(12)).expect(403);
  });

  it('lets an active paid term through', async () => {
    const response = await call('pro', 'pro-user').expect(200);
    expect(response.body).toMatchObject({ data: { accessSource: 'PRO' } });
  });

  it('denies a user whose paid term has lapsed', async () => {
    await call('pro', 'lapsed-user').expect(403);
  });

  it('leaves endpoints without ProAccessGuard open to every authenticated user', async () => {
    for (const userId of ['new-user', 'lapsed-user', 'trial-user']) {
      await call('basic', userId).expect(200);
    }
    expect(prisma.userSubscription.findUnique.mock.calls).toHaveLength(0);
  });

  it('checks the subscription of the token’s user only', async () => {
    await call('pro?authId=pro-user&userId=pro-user', 'new-user').expect(403);
    expect(
      prisma.userSubscription.findUnique.mock.calls.map(([a]) => a.where),
    ).toEqual([{ authId: 'new-user' }]);
  });
});
