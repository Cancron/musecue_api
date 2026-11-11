import {
  Global,
  INestApplication,
  Module,
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
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { CustomLoggerService } from '../src/common/services/custom-logger.service';
import { PrismaService } from '../src/common/services/prisma.service';
import { RedisService } from '../src/common/services/redis.service';
import { addBillingInterval } from '../src/subscription/billing.validation';
import { SubscriptionModule } from '../src/subscription/subscription.module';
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

/** Fake only `Date`; timers stay real so Nest, pg and supertest keep working. */
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

describeWithDatabase('GET /v1/subscription (PostgreSQL, full stack)', () => {
  let app: INestApplication<App>;
  let schema: string;
  let client: PrismaClient;
  let originalSecret: string;
  const redis = mock<RedisService>();
  const tokens = new AuthUtilsService(mock<RedisService>());
  const T0 = new Date('2026-03-01T09:30:00.000Z');

  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;
  const dataOf = (response: { body: unknown }) =>
    (response.body as { data: Record<string, unknown> }).data;
  const statusAt = async (userId: string, now: Date) => {
    freezeTime(now);
    const response = await request(app.getHttpServer())
      .get('/v1/subscription')
      .set('Authorization', bearer(userId))
      .expect(200);
    return dataOf(response);
  };
  const activateAt = (userId: string, now: Date) => {
    freezeTime(now);
    return request(app.getHttpServer())
      .post('/v1/subscription/trial')
      .set('Authorization', bearer(userId));
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

    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'subscription-status-e2e-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseTestModule, SubscriptionModule],
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
    redis.get.mockResolvedValue(1 as never); // current tokenVersion
  });

  afterEach(() => jest.useRealTimers());

  it('returns FREE and an eligible trial for a user without a subscription record', async () => {
    const userId = await createUser(client);
    expect(await statusAt(userId, T0)).toMatchObject({
      status: 'FREE',
      hasProAccess: false,
      trial: { eligible: true, used: false, startedAt: null, expiresAt: null },
      pro: { active: false, startedAt: null },
    });
    await expect(
      client.userSubscription.count({ where: { authId: userId } }),
    ).resolves.toBe(0);
  });

  it('follows an activated trial through its exact expiry without a background job, leaving the trial history unchanged', async () => {
    const userId = await createUser(client);
    await activateAt(userId, T0).expect(201);
    const stored = await client.userSubscription.findUniqueOrThrow({
      where: { authId: userId },
    });

    expect(await statusAt(userId, daysFrom(T0, 3))).toMatchObject({
      status: 'TRIAL',
      hasProAccess: true,
      accessExpiresAt: daysFrom(T0, 7).toISOString(),
      trial: {
        eligible: false,
        ineligibleReason: 'TRIAL_ALREADY_USED',
        used: true,
        active: true,
        startedAt: T0.toISOString(),
        expiresAt: daysFrom(T0, 7).toISOString(),
      },
    });
    expect(
      await statusAt(userId, new Date(daysFrom(T0, 7).getTime() - 1)),
    ).toMatchObject({ status: 'TRIAL', hasProAccess: true });

    const expired = await statusAt(userId, daysFrom(T0, 7));
    expect(expired).toMatchObject({
      status: 'EXPIRED',
      hasProAccess: false,
      accessExpiresAt: null,
      trial: {
        eligible: false,
        ineligibleReason: 'TRIAL_ALREADY_USED',
        used: true,
        active: false,
        startedAt: T0.toISOString(),
        expiresAt: daysFrom(T0, 7).toISOString(),
      },
    });

    // The stored record, including status 'TRIAL', is untouched by reads.
    await expect(
      client.userSubscription.findUniqueOrThrow({ where: { authId: userId } }),
    ).resolves.toEqual(stored);
    // And the expired trial cannot be restarted.
    await activateAt(userId, daysFrom(T0, 8)).expect(409);
  });

  it.each([BillingInterval.MONTHLY, BillingInterval.YEARLY])(
    'returns PRO for an active %s term and EXPIRED at its exact expiry',
    async (billingInterval) => {
      const userId = await createUser(client);
      const term = {
        billingInterval,
        startedAt: daysFrom(T0, -5),
        expiresAt: addBillingInterval(daysFrom(T0, -5), billingInterval),
        canceledAt: daysFrom(T0, -1),
      };
      await givenPaidProHistory(client, userId, term, T0);

      expect(await statusAt(userId, T0)).toMatchObject({
        status: 'PRO',
        hasProAccess: true,
        accessSource: 'PRO',
        accessExpiresAt: term.expiresAt.toISOString(),
        trial: { eligible: false, ineligibleReason: 'HAS_PRO_HISTORY' },
        pro: {
          active: true,
          billingInterval,
          startedAt: term.startedAt.toISOString(),
          expiresAt: term.expiresAt.toISOString(),
          canceledAt: term.canceledAt.toISOString(),
        },
      });
      expect(
        await statusAt(userId, new Date(term.expiresAt.getTime() - 1)),
      ).toMatchObject({ status: 'PRO' });
      expect(await statusAt(userId, term.expiresAt)).toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
        pro: { active: false },
      });
    },
  );

  it('shows each user only their own subscription', async () => {
    const trialUser = await createUser(client);
    const proUser = await createUser(client);
    await activateAt(trialUser, T0).expect(201);
    await givenPaidProHistory(
      client,
      proUser,
      {
        billingInterval: BillingInterval.YEARLY,
        startedAt: daysFrom(T0, -1),
      },
      T0,
    );

    expect(await statusAt(trialUser, daysFrom(T0, 1))).toMatchObject({
      status: 'TRIAL',
      pro: { billingInterval: null },
    });
    expect(await statusAt(proUser, daysFrom(T0, 1))).toMatchObject({
      status: 'PRO',
      trial: { used: false, startedAt: null },
    });

    freezeTime(daysFrom(T0, 1));
    const spoofed = await request(app.getHttpServer())
      .get(`/v1/subscription?authId=${proUser}&userId=${proUser}`)
      .set('Authorization', bearer(trialUser))
      .expect(200);
    expect(dataOf(spoofed)).toMatchObject({ status: 'TRIAL' });
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/v1/subscription').expect(401);
  });
});
