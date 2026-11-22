import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { DiscountSettings } from '@prisma/client';
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
import { DiscountsModule } from './discounts.module';

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

const ROUTE = '/v1/admin/discount-settings';

const dataOf = (response: { body: unknown }) =>
  (response.body as { data: unknown }).data;

describe('Discount settings administration (HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  let stored: DiscountSettings;
  let startupInserts: unknown[];
  const seededAt = new Date('2026-11-30T12:00:00.000Z');
  const updatedAt = new Date('2026-12-01T12:00:00.000Z');
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
      .set('User-Agent', 'discount-spec')
      .send(body as object);
  const nothingWritten = () => {
    expect(prisma.discountSettings.update.mock.calls).toHaveLength(0);
    expect(prisma.activityLogEvent.create.mock.calls).toHaveLength(0);
  };

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'discount-settings-spec-secret';

    prisma.discountSettings.createMany.mockResolvedValue({ count: 1 });
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, DiscountsModule],
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
    startupInserts = prisma.discountSettings.createMany.mock.calls.map(
      ([args]) => args,
    );
  });

  afterAll(async () => {
    await app?.close();
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // An in-memory stand-in for the settings row, seeded with the defaults.
    stored = {
      id: 1,
      firstPurchaseDiscountPercent: 0,
      referralDiscountPercent: 0,
      referrerRewardCredits: 0,
      createdAt: seededAt,
      updatedAt: seededAt,
    };
    tokenVersions.get.mockResolvedValue(1);
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.discountSettings.createMany.mockResolvedValue({ count: 0 });
    prisma.discountSettings.findUnique.mockImplementation((() =>
      Promise.resolve(stored)) as never);
    prisma.discountSettings.findUniqueOrThrow.mockImplementation((() =>
      Promise.resolve(stored)) as never);
    prisma.discountSettings.update.mockImplementation(((args: {
      data: Partial<DiscountSettings>;
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
        .send({ referralDiscountPercent: 10 })
        .expect(401);
      await get('Basic YWRtaW46YWRtaW4=').expect(401);
      await patch({ referralDiscountPercent: 10 }, 'Bearer not-a-jwt').expect(
        401,
      );
      nothingWritten();
    });

    it('rejects a revoked admin token (tokenVersion changed)', async () => {
      tokenVersions.get.mockResolvedValue(2);
      await patch({ referralDiscountPercent: 10 }).expect(401);
      nothingWritten();
    });

    it.each([UserRole.USER, UserRole.MODERATOR])(
      'forbids a %s from reading or changing the settings',
      async (role) => {
        await get(bearer(role)).expect(403);
        await patch({ referrerRewardCredits: 500 }, bearer(role)).expect(403);
        expect(prisma.discountSettings.findUnique.mock.calls).toHaveLength(0);
        nothingWritten();
      },
    );

    it.each([UserRole.ADMIN, UserRole.SUPERADMIN])(
      'lets a %s read and change the settings',
      async (role) => {
        await get(bearer(role)).expect(200);
        await patch({ referralDiscountPercent: 10 }, bearer(role)).expect(200);
        expect(prisma.discountSettings.update.mock.calls).toHaveLength(1);
      },
    );

    it('records the acting administrator from the token, not the body', async () => {
      await patch(
        { firstPurchaseDiscountPercent: 25 },
        bearer(UserRole.SUPERADMIN, 'superadmin-7'),
      ).expect(200);
      expect(prisma.activityLogEvent.create.mock.calls[0]?.[0].data).toEqual(
        expect.objectContaining({
          tableName: 'DiscountSettings',
          recordId: '1',
          actionedBy: 'superadmin-7',
          userAgent: 'discount-spec',
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

    it('serves 0 (offer off) for every setting before any change', async () => {
      const response = await get().expect(200);
      expect(response.body).toEqual({
        statusCode: 200,
        message: 'Success',
        data: {
          firstPurchaseDiscountPercent: 0,
          firstPurchaseDiscountActive: false,
          referralDiscountPercent: 0,
          referralDiscountActive: false,
          referrerRewardCredits: 0,
          referrerRewardActive: false,
          updatedAt: seededAt.toISOString(),
        },
      });
    });
  });

  describe('updates', () => {
    it('changes only the supplied fields across successive requests', async () => {
      await patch({ firstPurchaseDiscountPercent: 20 }).expect(200);
      await patch({ referralDiscountPercent: 15 }).expect(200);
      const response = await patch({ referrerRewardCredits: 200 }).expect(200);

      expect(dataOf(response)).toEqual({
        firstPurchaseDiscountPercent: 20,
        firstPurchaseDiscountActive: true,
        referralDiscountPercent: 15,
        referralDiscountActive: true,
        referrerRewardCredits: 200,
        referrerRewardActive: true,
        updatedAt: updatedAt.toISOString(),
      });
    });
  });

  describe('validation', () => {
    it.each([
      ['an empty body', {}],
      [
        'a negative first-purchase discount',
        { firstPurchaseDiscountPercent: -1 },
      ],
      [
        'a first-purchase discount above 100%',
        { firstPurchaseDiscountPercent: 101 },
      ],
      [
        'a fractional first-purchase discount',
        { firstPurchaseDiscountPercent: 12.5 },
      ],
      ['a discount given as a fraction', { referralDiscountPercent: 0.2 }],
      ['a negative referral discount', { referralDiscountPercent: -10 }],
      ['a referral discount above 100%', { referralDiscountPercent: 150 }],
      ['a percentage string', { referralDiscountPercent: '10%' }],
      ['a numeric string', { referralDiscountPercent: '10' }],
      ['negative reward credits', { referrerRewardCredits: -1 }],
      ['fractional reward credits', { referrerRewardCredits: 10.5 }],
      ['reward credits above 100000', { referrerRewardCredits: 100_001 }],
      ['reward credits as a string', { referrerRewardCredits: '100' }],
      ['a boolean', { referrerRewardCredits: true }],
      ['null', { firstPurchaseDiscountPercent: null }],
      ['an array', { referralDiscountPercent: [10] }],
      ['a huge number', { referrerRewardCredits: 1e308 }],
      ['a read-only active flag', { referralDiscountActive: true }],
      ['an unknown field', { referralDiscountPercent: 10, id: 2 }],
      [
        'one invalid field alongside valid ones',
        {
          firstPurchaseDiscountPercent: 10,
          referralDiscountPercent: 10,
          referrerRewardCredits: -5,
        },
      ],
    ])('rejects %s with 400 and persists nothing', async (_case, body) => {
      const response = await patch(body).expect(400);
      expect(response.body).toMatchObject({ success: false, statusCode: 400 });
      nothingWritten();
    });

    it.each([
      [
        'the minimums (every offer off)',
        {
          firstPurchaseDiscountPercent: 0,
          referralDiscountPercent: 0,
          referrerRewardCredits: 0,
        },
      ],
      [
        'the maximums',
        {
          firstPurchaseDiscountPercent: 100,
          referralDiscountPercent: 100,
          referrerRewardCredits: 100_000,
        },
      ],
    ])('accepts %s', async (_case, body) => {
      await patch(body).expect(200);
      expect(prisma.discountSettings.update.mock.calls).toHaveLength(1);
    });
  });
});
