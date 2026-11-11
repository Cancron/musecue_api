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
import { BillingInterval, PrismaClient } from '@prisma/client';
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
import {
  ProAccessGuard,
  type ProAccessRequest,
} from '../src/subscription/pro-access.guard';
import { addBillingInterval } from '../src/subscription/billing.validation';
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
  givenPaidProHistory,
} from './support/subscription-fixtures';

jest.setTimeout(60_000);

@UseGuards(AuthGuard, ProAccessGuard)
@Controller('v1/test-pro-feature')
class ProFeatureTestController {
  @Get()
  use(@Req() req: ProAccessRequest) {
    return { accessSource: req.proAccess.accessSource };
  }
}

describeWithDatabase('ProAccessGuard (PostgreSQL, full stack)', () => {
  let app: INestApplication<App>;
  let schema: string;
  let client: PrismaClient;
  let originalSecret: string;
  const redis = mock<RedisService>();
  const tokens = new AuthUtilsService(mock<RedisService>());
  const T0 = new Date('2026-03-01T09:30:00.000Z');

  const as = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;
  const useProFeature = (userId: string, now: Date) => {
    freezeTime(now);
    return request(app.getHttpServer())
      .get('/v1/test-pro-feature')
      .set('Authorization', as(userId));
  };

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
    config.jwt_access_secret = 'pro-access-e2e-secret';
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
    await app.init();
  });

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(() => {
    redis.get.mockResolvedValue(1 as never);
  });

  afterEach(() => jest.useRealTimers());

  it('denies a user without a subscription', async () => {
    const userId = await createUser(client);
    await useProFeature(userId, T0).expect(403);
  });

  it('opens Pro features for an activated trial and closes them at the exact trial expiry, without changing the record', async () => {
    const userId = await createUser(client);
    await useProFeature(userId, T0).expect(403);

    freezeTime(T0);
    await request(app.getHttpServer())
      .post('/v1/subscription/trial')
      .set('Authorization', as(userId))
      .expect(201);
    const stored = await client.userSubscription.findUniqueOrThrow({
      where: { authId: userId },
    });

    const during = await useProFeature(userId, daysFrom(T0, 3)).expect(200);
    expect(during.body).toMatchObject({ data: { accessSource: 'TRIAL' } });
    await useProFeature(userId, new Date(daysFrom(T0, 7).getTime() - 1)).expect(
      200,
    );
    await useProFeature(userId, daysFrom(T0, 7)).expect(403);
    await useProFeature(userId, daysFrom(T0, 60)).expect(403);

    await expect(
      client.userSubscription.findUniqueOrThrow({ where: { authId: userId } }),
    ).resolves.toEqual(stored);
  });

  it('opens Pro features for a paid term (fixture) and closes them when it expires', async () => {
    const userId = await createUser(client);
    const expiresAt = addBillingInterval(T0, BillingInterval.MONTHLY);
    await givenPaidProHistory(
      client,
      userId,
      {
        billingInterval: BillingInterval.MONTHLY,
        startedAt: T0,
        expiresAt,
        canceledAt: daysFrom(T0, 2),
      },
      T0,
    );

    const during = await useProFeature(userId, daysFrom(T0, 10)).expect(200);
    expect(during.body).toMatchObject({ data: { accessSource: 'PRO' } });
    await useProFeature(userId, expiresAt).expect(403);
  });

  it('denies a user whose only paid term expired long ago', async () => {
    const userId = await createUser(client);
    await givenPaidProHistory(
      client,
      userId,
      {
        billingInterval: BillingInterval.YEARLY,
        startedAt: daysFrom(T0, -400),
      },
      T0,
    );
    await useProFeature(userId, T0).expect(403);
  });
});
