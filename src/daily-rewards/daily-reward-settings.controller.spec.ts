import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { DailyRewardSettings } from '@prisma/client';
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
import { DailyRewardsModule } from './daily-rewards.module';

const prisma = mockDeep<PrismaService>();
const tokenVersions = mock<TokenVersionCache>();

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: CustomLoggerService, useValue: mock<CustomLoggerService>() },
    { provide: TokenVersionCache, useValue: tokenVersions },
  ],
  exports: [PrismaService, CustomLoggerService, TokenVersionCache],
})
class TestInfrastructureModule {}

const ROUTE = '/v1/admin/daily-reward-settings';

const dataOf = (response: { body: unknown }) =>
  (response.body as { data: unknown }).data;

describe('Daily reward settings administration (HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  let stored: DailyRewardSettings;
  let startupInserts: unknown[];
  const seededAt = new Date('2026-11-30T12:00:00.000Z');
  const updatedAt = new Date('2026-12-01T12:00:00.000Z');
  const tokens = new AuthUtilsService(mock<RateLimitStore>());

  const bearer = (role: UserRole, userId = 'user-id') =>
    `Bearer ${tokens.createAccessToken({ userId, role, tokenVersion: 1 })}`;

  const get = (auth = bearer(UserRole.ADMIN, 'admin-id')) =>
    request(app.getHttpServer()).get(ROUTE).set('Authorization', auth);
  const patch = (body: unknown, auth = bearer(UserRole.ADMIN, 'admin-id')) =>
    request(app.getHttpServer())
      .patch(ROUTE)
      .set('Authorization', auth)
      .set('User-Agent', 'daily-reward-spec')
      .send(body as object);
  const nothingWritten = () => {
    expect(prisma.dailyRewardSettings.update.mock.calls).toHaveLength(0);
    expect(prisma.activityLogEvent.create.mock.calls).toHaveLength(0);
  };

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'daily-reward-settings-spec-secret';

    prisma.dailyRewardSettings.createMany.mockResolvedValue({ count: 1 });
    // Startup of the imported CreditsModule (settings already stored).
    prisma.creditSettings.createMany.mockResolvedValue({ count: 0 });
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, DailyRewardsModule],
    }).compile();

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
    startupInserts = prisma.dailyRewardSettings.createMany.mock.calls.map(
      ([args]) => args,
    );
  });

  afterAll(async () => {
    await app?.close();
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    stored = {
      id: 1,
      startingRewardCredits: 10,
      dailyIncrementCredits: 10,
      maxDailyRewardCredits: 50,
      createdAt: seededAt,
      updatedAt: seededAt,
    };
    tokenVersions.get.mockResolvedValue(1);
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.dailyRewardSettings.createMany.mockResolvedValue({ count: 0 });
    prisma.dailyRewardSettings.findUnique.mockImplementation((() =>
      Promise.resolve(stored)) as never);
    prisma.dailyRewardSettings.findUniqueOrThrow.mockImplementation((() =>
      Promise.resolve(stored)) as never);
    prisma.dailyRewardSettings.update.mockImplementation(((args: {
      data: Partial<DailyRewardSettings>;
    }) => {
      stored = { ...stored, ...args.data, updatedAt };
      return Promise.resolve(stored);
    }) as never);
  });

  describe('permission control', () => {
    it('rejects requests without a token or with a malformed one', async () => {
      await request(app.getHttpServer()).get(ROUTE).expect(401);
      await request(app.getHttpServer())
        .patch(ROUTE)
        .send({ startingRewardCredits: 20 })
        .expect(401);
      await patch({ startingRewardCredits: 20 }, 'Bearer not-a-jwt').expect(
        401,
      );
      nothingWritten();
    });

    it.each([UserRole.USER, UserRole.MODERATOR])(
      'forbids a %s from reading or changing the settings',
      async (role) => {
        await get(bearer(role)).expect(403);
        await patch({ maxDailyRewardCredits: 600 }, bearer(role)).expect(403);
        expect(prisma.dailyRewardSettings.findUnique.mock.calls).toHaveLength(
          0,
        );
        nothingWritten();
      },
    );

    it.each([UserRole.ADMIN, UserRole.SUPERADMIN])(
      'lets a %s read and change the settings',
      async (role) => {
        await get(bearer(role)).expect(200);
        await patch({ dailyIncrementCredits: 5 }, bearer(role)).expect(200);
        expect(prisma.dailyRewardSettings.update.mock.calls).toHaveLength(1);
      },
    );
  });

  describe('default values', () => {
    it('stores the defaults in the database when the application starts', () => {
      expect(startupInserts).toEqual([
        { data: [{ id: 1 }], skipDuplicates: true },
      ]);
    });

    it('serves the defaults and the monthly cap in the standard envelope', async () => {
      const response = await get().expect(200);
      expect(response.body).toEqual({
        statusCode: 200,
        message: 'Success',
        data: {
          startingRewardCredits: 10,
          dailyIncrementCredits: 10,
          maxDailyRewardCredits: 50,
          monthlyCapCredits: 600,
          updatedAt: seededAt.toISOString(),
        },
      });
    });
  });

  describe('updates', () => {
    it('changes only the supplied fields across successive requests', async () => {
      await patch({ maxDailyRewardCredits: 100 }).expect(200);
      await patch({ startingRewardCredits: 20 }).expect(200);
      const response = await patch({ dailyIncrementCredits: 0 }).expect(200);

      expect(dataOf(response)).toEqual({
        startingRewardCredits: 20,
        dailyIncrementCredits: 0,
        maxDailyRewardCredits: 100,
        monthlyCapCredits: 600,
        updatedAt: updatedAt.toISOString(),
      });
    });
  });

  describe('validation', () => {
    it.each([
      ['an empty body', {}],
      ['a negative starting reward', { startingRewardCredits: -10 }],
      ['a zero starting reward', { startingRewardCredits: 0 }],
      ['a fractional starting reward', { startingRewardCredits: 10.5 }],
      ['a negative increment', { dailyIncrementCredits: -1 }],
      ['a fractional increment', { dailyIncrementCredits: 0.5 }],
      ['an increment above 600', { dailyIncrementCredits: 601 }],
      ['a negative maximum', { maxDailyRewardCredits: -50 }],
      ['a zero maximum', { maxDailyRewardCredits: 0 }],
      ['a fractional maximum', { maxDailyRewardCredits: 49.9 }],
      ['a maximum above the monthly cap', { maxDailyRewardCredits: 601 }],
      ['a starting reward above 600', { startingRewardCredits: 601 }],
      ['a numeric string', { startingRewardCredits: '10' }],
      ['a boolean', { dailyIncrementCredits: false }],
      ['null', { maxDailyRewardCredits: null }],
      ['the read-only monthly cap', { monthlyCapCredits: 1000 }],
      ['an unknown field', { startingRewardCredits: 10, userId: 'x' }],
      [
        'a starting reward above the stored maximum',
        { startingRewardCredits: 60 },
      ],
      [
        'a maximum below the stored starting reward',
        { maxDailyRewardCredits: 5 },
      ],
      [
        'one invalid field alongside valid ones',
        { startingRewardCredits: 5, maxDailyRewardCredits: 1000 },
      ],
    ])('rejects %s with 400 and persists nothing', async (_case, body) => {
      const response = await patch(body).expect(400);
      expect(response.body).toMatchObject({ success: false, statusCode: 400 });
      nothingWritten();
    });

    it.each([
      [
        'the minimums',
        {
          startingRewardCredits: 1,
          dailyIncrementCredits: 0,
          maxDailyRewardCredits: 1,
        },
      ],
      [
        'the maximums',
        {
          startingRewardCredits: 600,
          dailyIncrementCredits: 600,
          maxDailyRewardCredits: 600,
        },
      ],
    ])('accepts %s', async (_case, body) => {
      await patch(body).expect(200);
      expect(prisma.dailyRewardSettings.update.mock.calls).toHaveLength(1);
    });
  });
});
