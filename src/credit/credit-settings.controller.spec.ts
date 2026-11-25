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
import { CreditModule } from './credit.module';

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

const dataOf = (response: { body: unknown }) =>
  (response.body as { data: unknown }).data;

/**
 * HTTP contract of the credit settings administration with an in-memory
 * stand-in for PostgreSQL (see test/credit-settings.e2e-spec.ts for the
 * real-database version).
 */
describe('Credit settings administration (HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  let stored: CreditSettings;
  const seededAt = new Date('2026-11-22T00:00:00.000Z');
  const updatedAt = new Date('2026-11-22T12:00:00.000Z');
  const tokens = new AuthUtilsService(mock<RateLimitStore>());

  const bearer = (role: string, userId = 'user-id') =>
    `Bearer ${tokens.createAccessToken({ userId, role: role as UserRole, tokenVersion: 1 })}`;

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'credit-settings-spec-secret';

    // Startup stores the configuration row if it is missing (onModuleInit).
    prisma.creditSettings.createMany.mockResolvedValue({ count: 0 });
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, CreditModule],
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
    expect(prisma.creditSettings.createMany.mock.calls).toEqual([
      [{ data: [{ id: 'default' }], skipDuplicates: true }],
    ]);
  });

  afterAll(async () => {
    await app?.close();
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // The migration-seeded configuration row.
    stored = {
      id: 'default',
      trialAllowanceCredits: 50,
      proMonthlyAllowanceCredits: 1000,
      openRouterUsdMicrosPerCredit: 5000,
      sessionOverageAllowanceCredits: 5,
      createdAt: seededAt,
      updatedAt: seededAt,
    };
    tokenVersions.get.mockResolvedValue(1);
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
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

  const get = (auth?: string) => {
    const req = request(app.getHttpServer()).get(ROUTE);
    return auth ? req.set('Authorization', auth) : req;
  };
  const patch = (body: unknown, auth = bearer(UserRole.ADMIN, 'admin-id')) =>
    request(app.getHttpServer())
      .patch(ROUTE)
      .set('Authorization', auth)
      .set('User-Agent', 'credit-spec')
      .send(body as object);

  describe('permission control', () => {
    it('rejects requests without a token', async () => {
      await get().expect(401);
      await request(app.getHttpServer())
        .patch(ROUTE)
        .send({ trialAllowanceCredits: 1 })
        .expect(401);
      expect(prisma.creditSettings.update.mock.calls).toHaveLength(0);
    });

    it('rejects a token signed with another secret', async () => {
      const current = config.jwt_access_secret;
      config.jwt_access_secret = 'another-secret';
      const forged = bearer(UserRole.SUPERADMIN);
      config.jwt_access_secret = current;

      await get(forged).expect(401);
      await patch({ trialAllowanceCredits: 1 }, forged).expect(401);
      expect(prisma.creditSettings.update.mock.calls).toHaveLength(0);
    });

    it.each([UserRole.USER, UserRole.MODERATOR, 'admin', ''])(
      'forbids the role %p from reading or changing the settings',
      async (role) => {
        await get(bearer(role)).expect(403);
        await patch({ trialAllowanceCredits: 1000 }, bearer(role)).expect(403);
        expect(prisma.creditSettings.findUnique.mock.calls).toHaveLength(0);
        expect(prisma.creditSettings.update.mock.calls).toHaveLength(0);
        expect(prisma.activityLogEvent.create.mock.calls).toHaveLength(0);
      },
    );

    it.each([UserRole.ADMIN, UserRole.SUPERADMIN])(
      'lets a %s read and change the settings',
      async (role) => {
        await get(bearer(role)).expect(200);
        await patch({ trialAllowanceCredits: 60 }, bearer(role)).expect(200);
        expect(prisma.creditSettings.update.mock.calls).toHaveLength(1);
      },
    );

    it('records the acting administrator', async () => {
      await patch(
        { sessionOverageAllowanceCredits: 8 },
        bearer(UserRole.ADMIN, 'admin-42'),
      ).expect(200);
      expect(prisma.activityLogEvent.create.mock.calls[0]?.[0].data).toEqual(
        expect.objectContaining({
          tableName: 'CreditSettings',
          recordId: 'default',
          actionedBy: 'admin-42',
          userAgent: 'credit-spec',
        }),
      );
    });
  });

  describe('default values', () => {
    it('serves the stored defaults in the standard envelope before any administrator change', async () => {
      const response = await get(bearer(UserRole.ADMIN)).expect(200);
      expect(response.body).toEqual({
        statusCode: 200,
        message: 'Success',
        data: {
          trialAllowanceCredits: 50,
          proMonthlyAllowanceCredits: 1000,
          openRouterUsdMicrosPerCredit: 5000,
          openRouterUsdPerCredit: '0.005',
          sessionOverageAllowanceCredits: 5,
          updatedAt: seededAt.toISOString(),
        },
      });
    });
  });

  describe('updates', () => {
    it('changes only the supplied fields across successive requests', async () => {
      await patch({ trialAllowanceCredits: 25 }).expect(200);
      const response = await patch({
        openRouterUsdMicrosPerCredit: 2500,
      }).expect(200);

      expect(dataOf(response)).toEqual({
        trialAllowanceCredits: 25,
        proMonthlyAllowanceCredits: 1000,
        openRouterUsdMicrosPerCredit: 2500,
        openRouterUsdPerCredit: '0.0025',
        sessionOverageAllowanceCredits: 5,
        updatedAt: updatedAt.toISOString(),
      });
    });

    it('accepts every field in one request', async () => {
      const all = {
        trialAllowanceCredits: 0,
        proMonthlyAllowanceCredits: 5000,
        openRouterUsdMicrosPerCredit: 10_000,
        sessionOverageAllowanceCredits: 0,
      };
      const response = await patch(all).expect(200);
      expect(dataOf(response)).toMatchObject({
        ...all,
        openRouterUsdPerCredit: '0.01',
      });
    });
  });

  describe('validation', () => {
    it.each([
      ['an empty body', {}],
      ['a negative trial allowance', { trialAllowanceCredits: -1 }],
      ['a negative Pro allowance', { proMonthlyAllowanceCredits: -1000 }],
      ['a negative overage', { sessionOverageAllowanceCredits: -5 }],
      ['a negative cost per credit', { openRouterUsdMicrosPerCredit: -5000 }],
      ['a zero cost per credit', { openRouterUsdMicrosPerCredit: 0 }],
      ['a dollar amount as cost', { openRouterUsdMicrosPerCredit: 0.005 }],
      ['a fractional allowance', { trialAllowanceCredits: 50.5 }],
      ['a string allowance', { proMonthlyAllowanceCredits: '1000' }],
      ['a null allowance', { trialAllowanceCredits: null }],
      ['a boolean overage', { sessionOverageAllowanceCredits: true }],
      ['an allowance above 1,000,000', { trialAllowanceCredits: 1_000_001 }],
      ['a cost above $1', { openRouterUsdMicrosPerCredit: 1_000_001 }],
      ['an overage above 10,000', { sessionOverageAllowanceCredits: 10_001 }],
      ['the read-only dollar field', { openRouterUsdPerCredit: '0.01' }],
      ['an unknown field', { trialAllowanceCredits: 50, credits: 1 }],
      [
        'one invalid field next to valid ones',
        { trialAllowanceCredits: 70, sessionOverageAllowanceCredits: -1 },
      ],
    ])('rejects %s with 400 and persists nothing', async (_case, body) => {
      const response = await patch(body).expect(400);
      expect(response.body).toMatchObject({ success: false, statusCode: 400 });
      expect(prisma.creditSettings.update.mock.calls).toHaveLength(0);
      expect(prisma.activityLogEvent.create.mock.calls).toHaveLength(0);
    });

    it.each([
      [
        'the minimum values',
        {
          trialAllowanceCredits: 0,
          proMonthlyAllowanceCredits: 0,
          openRouterUsdMicrosPerCredit: 1,
          sessionOverageAllowanceCredits: 0,
        },
      ],
      [
        'the maximum values',
        {
          trialAllowanceCredits: 1_000_000,
          proMonthlyAllowanceCredits: 1_000_000,
          openRouterUsdMicrosPerCredit: 1_000_000,
          sessionOverageAllowanceCredits: 10_000,
        },
      ],
    ])('accepts %s', async (_case, body) => {
      await patch(body).expect(200);
      expect(prisma.creditSettings.update.mock.calls).toHaveLength(1);
    });
  });
});
