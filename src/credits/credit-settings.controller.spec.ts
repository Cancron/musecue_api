import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { CreditSettings } from '@prisma/client';
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
import { CreditsModule } from './credits.module';

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

const ROUTE = '/v1/admin/credit-settings';

/** The `data` member of the response envelope. */
const dataOf = (response: { body: unknown }) =>
  (response.body as { data: unknown }).data;

describe('Credit settings administration (HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  let stored: CreditSettings;
  let startupInserts: unknown[];
  const seededAt = new Date('2026-11-23T12:00:00.000Z');
  const updatedAt = new Date('2026-11-24T12:00:00.000Z');
  const tokens = new AuthUtilsService(mock<RateLimitStore>());

  /** A token minted by the unchanged production token code. */
  const bearer = (role: UserRole, userId = 'user-id') =>
    `Bearer ${tokens.createAccessToken({ userId, role, tokenVersion: 1 })}`;

  const get = (auth = bearer(UserRole.ADMIN, 'admin-id')) =>
    request(app.getHttpServer()).get(ROUTE).set('Authorization', auth);
  const patch = (body: unknown, auth = bearer(UserRole.ADMIN, 'admin-id')) =>
    request(app.getHttpServer())
      .patch(ROUTE)
      .set('Authorization', auth)
      .set('User-Agent', 'credit-spec')
      .send(body as object);
  const nothingWritten = () => {
    expect(prisma.creditSettings.update.mock.calls).toHaveLength(0);
    expect(prisma.activityLogEvent.create.mock.calls).toHaveLength(0);
  };

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'credit-settings-spec-secret';

    // Application startup stores the defaults (insert unless present).
    prisma.creditSettings.createMany.mockResolvedValue({ count: 1 });
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, CreditsModule],
    }).compile();

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
    startupInserts = prisma.creditSettings.createMany.mock.calls.map(
      ([args]) => args,
    );
  });

  afterAll(async () => {
    await app?.close();
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // An in-memory stand-in for the settings row, seeded with the column
    // defaults as the migration and startup store them.
    stored = {
      id: 1,
      trialCredits: 50,
      proMonthlyCredits: 1000,
      creditCostUsdMicros: 5000,
      sessionOverageCredits: 5,
      createdAt: seededAt,
      updatedAt: seededAt,
    };
    tokenVersions.get.mockResolvedValue(1); // cached tokenVersion
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.creditSettings.createMany.mockResolvedValue({ count: 0 });
    prisma.creditSettings.findUnique.mockImplementation((() =>
      Promise.resolve(stored)) as never);
    prisma.creditSettings.findUniqueOrThrow.mockImplementation((() =>
      Promise.resolve(stored)) as never);
    prisma.creditSettings.update.mockImplementation(((args: {
      data: Partial<CreditSettings>;
    }) => {
      stored = { ...stored, ...args.data, updatedAt };
      return Promise.resolve(stored);
    }) as never);
  });

  describe('permission control', () => {
    it('rejects requests without a token', async () => {
      await request(app.getHttpServer()).get(ROUTE).expect(401);
      await request(app.getHttpServer())
        .patch(ROUTE)
        .send({ trialCredits: 60 })
        .expect(401);
      nothingWritten();
    });

    it('rejects a malformed authorization header', async () => {
      await get('Basic YWRtaW46YWRtaW4=').expect(401);
      await patch({ trialCredits: 60 }, 'Bearer not-a-jwt').expect(401);
      nothingWritten();
    });

    it('rejects a token signed with another secret, even with an admin role', async () => {
      const current = config.jwt_access_secret;
      config.jwt_access_secret = 'another-secret';
      const forged = bearer(UserRole.SUPERADMIN);
      config.jwt_access_secret = current;

      await get(forged).expect(401);
      await patch({ trialCredits: 60 }, forged).expect(401);
      nothingWritten();
    });

    it('rejects a revoked admin token (tokenVersion changed)', async () => {
      tokenVersions.get.mockResolvedValue(2);
      await patch({ trialCredits: 60 }).expect(401);
      nothingWritten();
    });

    it.each([UserRole.USER, UserRole.MODERATOR])(
      'forbids a %s from reading or changing the settings',
      async (role) => {
        await get(bearer(role)).expect(403);
        await patch({ trialCredits: 60 }, bearer(role)).expect(403);
        expect(prisma.creditSettings.findUnique.mock.calls).toHaveLength(0);
        nothingWritten();
      },
    );

    it.each([UserRole.ADMIN, UserRole.SUPERADMIN])(
      'lets a %s read and change the settings',
      async (role) => {
        await get(bearer(role)).expect(200);
        await patch({ proMonthlyCredits: 1200 }, bearer(role)).expect(200);
        expect(prisma.creditSettings.update.mock.calls).toHaveLength(1);
      },
    );

    it('records the acting administrator from the token, not the body', async () => {
      await patch(
        { trialCredits: 60 },
        bearer(UserRole.ADMIN, 'admin-42'),
      ).expect(200);
      expect(prisma.activityLogEvent.create.mock.calls[0]?.[0].data).toEqual(
        expect.objectContaining({
          tableName: 'CreditSettings',
          recordId: '1',
          actionedBy: 'admin-42',
          userAgent: 'credit-spec',
        }),
      );
    });
  });

  describe('default values', () => {
    it('stores the defaults in the database when the application starts', () => {
      expect(startupInserts).toEqual([
        { data: [{ id: 1 }], skipDuplicates: true },
      ]);
    });

    it('serves the stored defaults in the standard envelope before any change', async () => {
      const response = await get().expect(200);
      expect(response.body).toEqual({
        statusCode: 200,
        message: 'Success',
        data: {
          trialCredits: 50,
          proMonthlyCredits: 1000,
          creditCostUsdMicros: 5000,
          creditCostUsd: '0.005',
          sessionOverageCredits: 5,
          updatedAt: seededAt.toISOString(),
        },
      });
    });
  });

  describe('updates', () => {
    it('changes only the supplied fields across successive requests', async () => {
      await patch({ trialCredits: 25 }).expect(200);
      await patch({ creditCostUsdMicros: 2500 }).expect(200);
      const response = await patch({ sessionOverageCredits: 0 }).expect(200);

      expect(dataOf(response)).toEqual({
        trialCredits: 25,
        proMonthlyCredits: 1000,
        creditCostUsdMicros: 2500,
        creditCostUsd: '0.0025',
        sessionOverageCredits: 0,
        updatedAt: updatedAt.toISOString(),
      });
    });

    it('accepts every field in one request', async () => {
      const all = {
        trialCredits: 100,
        proMonthlyCredits: 2000,
        creditCostUsdMicros: 10_000,
        sessionOverageCredits: 10,
      };
      const response = await patch(all).expect(200);
      expect(dataOf(response)).toMatchObject({ ...all, creditCostUsd: '0.01' });
    });
  });

  describe('validation', () => {
    it.each([
      ['an empty body', {}],
      ['negative trial credits', { trialCredits: -1 }],
      ['zero trial credits', { trialCredits: 0 }],
      ['trial credits above 100000', { trialCredits: 100_001 }],
      ['negative Pro credits', { proMonthlyCredits: -1000 }],
      ['zero Pro credits', { proMonthlyCredits: 0 }],
      ['Pro credits above 1000000', { proMonthlyCredits: 1_000_001 }],
      ['a negative credit cost', { creditCostUsdMicros: -5000 }],
      ['a zero credit cost', { creditCostUsdMicros: 0 }],
      ['a credit cost in dollars', { creditCostUsdMicros: 0.005 }],
      ['a credit cost above $1', { creditCostUsdMicros: 1_000_001 }],
      ['negative overage credits', { sessionOverageCredits: -5 }],
      ['overage credits above 1000', { sessionOverageCredits: 1001 }],
      ['fractional trial credits', { trialCredits: 50.5 }],
      ['fractional Pro credits', { proMonthlyCredits: 999.5 }],
      ['a fractional credit cost', { creditCostUsdMicros: 4999.5 }],
      ['fractional overage credits', { sessionOverageCredits: 2.5 }],
      ['a numeric string', { proMonthlyCredits: '1000' }],
      ['a boolean', { sessionOverageCredits: true }],
      ['null', { trialCredits: null }],
      ['an array', { trialCredits: [50] }],
      ['Infinity-like overflow', { proMonthlyCredits: 1e308 }],
      ['the read-only creditCostUsd', { creditCostUsd: '0.01' }],
      ['an unknown field', { trialCredits: 60, userId: 'someone-else' }],
      [
        'one invalid field alongside valid ones',
        {
          trialCredits: 60,
          proMonthlyCredits: 1500,
          sessionOverageCredits: -1,
        },
      ],
    ])('rejects %s with 400 and persists nothing', async (_case, body) => {
      const response = await patch(body).expect(400);
      expect(response.body).toMatchObject({ success: false, statusCode: 400 });
      nothingWritten();
    });

    it('rejects a body that is not a JSON object', async () => {
      await request(app.getHttpServer())
        .patch(ROUTE)
        .set('Authorization', bearer(UserRole.ADMIN))
        .set('Content-Type', 'application/json')
        .send('[{"trialCredits": 60}]')
        .expect(400);
      nothingWritten();
    });

    it.each([
      [
        'the minimums',
        {
          trialCredits: 1,
          proMonthlyCredits: 1,
          creditCostUsdMicros: 1,
          sessionOverageCredits: 0,
        },
      ],
      [
        'the maximums',
        {
          trialCredits: 100_000,
          proMonthlyCredits: 1_000_000,
          creditCostUsdMicros: 1_000_000,
          sessionOverageCredits: 1_000,
        },
      ],
    ])('accepts %s', async (_case, body) => {
      await patch(body).expect(200);
      expect(prisma.creditSettings.update.mock.calls).toHaveLength(1);
    });
  });
});
