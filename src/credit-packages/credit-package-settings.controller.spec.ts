import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { CreditPackage, CreditPackageCode } from '@prisma/client';
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
import { CreditPackagesModule } from './credit-packages.module';

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

const ROUTE = '/v1/admin/credit-package-settings';

const dataOf = (response: { body: unknown }) =>
  (response.body as { data: unknown }).data;

describe('Credit package settings administration (HTTP)', () => {
  let app: INestApplication<App>;
  let originalSecret: string;
  let stored: Map<CreditPackageCode, CreditPackage>;
  let startupInserts: unknown[];
  const seededAt = new Date('2026-11-30T12:00:00.000Z');
  const updatedAt = new Date('2026-12-01T12:00:00.000Z');
  const tokens = new AuthUtilsService(mock<RateLimitStore>());

  const bearer = (role: UserRole, userId = 'user-id') =>
    `Bearer ${tokens.createAccessToken({ userId, role, tokenVersion: 1 })}`;

  const get = (path = '', auth = bearer(UserRole.ADMIN, 'admin-id')) =>
    request(app.getHttpServer())
      .get(`${ROUTE}${path}`)
      .set('Authorization', auth);
  const patch = (
    code: string,
    body: unknown,
    auth = bearer(UserRole.ADMIN, 'admin-id'),
  ) =>
    request(app.getHttpServer())
      .patch(`${ROUTE}/${code}`)
      .set('Authorization', auth)
      .set('User-Agent', 'credit-package-spec')
      .send(body as object);
  const nothingWritten = () => {
    expect(prisma.creditPackage.update.mock.calls).toHaveLength(0);
    expect(prisma.activityLogEvent.create.mock.calls).toHaveLength(0);
  };

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'credit-package-settings-spec-secret';

    prisma.creditPackage.createMany.mockResolvedValue({ count: 3 });
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, CreditPackagesModule],
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
    startupInserts = prisma.creditPackage.createMany.mock.calls.map(
      ([args]) => args,
    );
  });

  afterAll(async () => {
    await app?.close();
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    const row = (
      code: CreditPackageCode,
      credits: number,
      priceUsdCents: number,
    ): CreditPackage => ({
      code,
      credits,
      priceUsdCents,
      available: true,
      createdAt: seededAt,
      updatedAt: seededAt,
    });
    // In-memory stand-ins for the package rows, seeded with the defaults.
    stored = new Map([
      ['SMALL', row('SMALL', 250, 500)],
      ['MEDIUM', row('MEDIUM', 500, 1000)],
      ['LARGE', row('LARGE', 1000, 2000)],
    ]);
    const byCode = (args: { where: { code: CreditPackageCode } }) =>
      Promise.resolve(stored.get(args.where.code) ?? null);
    tokenVersions.get.mockResolvedValue(1);
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.creditPackage.createMany.mockResolvedValue({ count: 0 });
    prisma.creditPackage.findMany.mockImplementation((() =>
      Promise.resolve([...stored.values()])) as never);
    prisma.creditPackage.findUnique.mockImplementation(byCode as never);
    prisma.creditPackage.findUniqueOrThrow.mockImplementation(byCode as never);
    prisma.creditPackage.update.mockImplementation(((args: {
      where: { code: CreditPackageCode };
      data: Partial<CreditPackage>;
    }) => {
      const next = {
        ...(stored.get(args.where.code) as CreditPackage),
        ...args.data,
        updatedAt,
      };
      stored.set(args.where.code, next);
      return Promise.resolve(next);
    }) as never);
  });

  describe('permission control', () => {
    it('rejects requests without a token or with a malformed one', async () => {
      await request(app.getHttpServer()).get(ROUTE).expect(401);
      await request(app.getHttpServer())
        .patch(`${ROUTE}/SMALL`)
        .send({ credits: 300 })
        .expect(401);
      await get('', 'Bearer not-a-jwt').expect(401);
      nothingWritten();
    });

    it.each([UserRole.USER, UserRole.MODERATOR])(
      'forbids a %s from reading or changing any package',
      async (role) => {
        await get('', bearer(role)).expect(403);
        await get('/SMALL', bearer(role)).expect(403);
        await patch('SMALL', { priceUsdCents: 50 }, bearer(role)).expect(403);
        // Unknown codes are not revealed to non-administrators either.
        await patch('HUGE', { priceUsdCents: 50 }, bearer(role)).expect(403);
        expect(prisma.creditPackage.findMany.mock.calls).toHaveLength(0);
        nothingWritten();
      },
    );

    it.each([UserRole.ADMIN, UserRole.SUPERADMIN])(
      'lets a %s read and change packages',
      async (role) => {
        await get('', bearer(role)).expect(200);
        await patch('MEDIUM', { available: false }, bearer(role)).expect(200);
        expect(prisma.creditPackage.update.mock.calls).toHaveLength(1);
      },
    );

    it('records the acting administrator and the package code', async () => {
      await patch(
        'LARGE',
        { credits: 1200 },
        bearer(UserRole.ADMIN, 'admin-9'),
      ).expect(200);
      expect(prisma.activityLogEvent.create.mock.calls[0]?.[0].data).toEqual(
        expect.objectContaining({
          tableName: 'CreditPackage',
          recordId: 'LARGE',
          actionedBy: 'admin-9',
          userAgent: 'credit-package-spec',
        }),
      );
    });
  });

  describe('default values', () => {
    it('stores the default packages in the database when the application starts', () => {
      expect(startupInserts).toEqual([
        {
          data: [
            {
              code: 'SMALL',
              credits: 250,
              priceUsdCents: 500,
              available: true,
            },
            {
              code: 'MEDIUM',
              credits: 500,
              priceUsdCents: 1000,
              available: true,
            },
            {
              code: 'LARGE',
              credits: 1000,
              priceUsdCents: 2000,
              available: true,
            },
          ],
          skipDuplicates: true,
        },
      ]);
    });

    it('serves the default packages in the standard envelope', async () => {
      const response = await get().expect(200);
      expect(response.body).toMatchObject({
        statusCode: 200,
        message: 'Success',
      });
      expect(
        (dataOf(response) as Array<Record<string, unknown>>).map((p) => [
          p.code,
          p.credits,
          p.priceUsdCents,
          p.priceUsd,
          p.currency,
          p.available,
        ]),
      ).toEqual([
        ['SMALL', 250, 500, '5.00', 'USD', true],
        ['MEDIUM', 500, 1000, '10.00', 'USD', true],
        ['LARGE', 1000, 2000, '20.00', 'USD', true],
      ]);
    });

    it('serves one package by code and 404 for an unknown one', async () => {
      expect(dataOf(await get('/MEDIUM').expect(200))).toMatchObject({
        code: 'MEDIUM',
        credits: 500,
        priceUsdCents: 1000,
      });
      await get('/HUGE').expect(404);
    });
  });

  describe('updates', () => {
    it('changes only the supplied fields of only the addressed package', async () => {
      await patch('SMALL', { credits: 300 }).expect(200);
      const response = await patch('SMALL', { priceUsdCents: 450 }).expect(200);

      expect(dataOf(response)).toEqual({
        code: 'SMALL',
        currency: 'USD',
        credits: 300,
        priceUsdCents: 450,
        priceUsd: '4.50',
        available: true,
        updatedAt: updatedAt.toISOString(),
      });
      expect(stored.get('MEDIUM')).toMatchObject({
        credits: 500,
        priceUsdCents: 1000,
      });
    });
  });

  describe('validation', () => {
    it.each([
      ['an empty body', {}],
      ['negative credits', { credits: -250 }],
      ['zero credits', { credits: 0 }],
      ['fractional credits', { credits: 250.5 }],
      ['credits above 1000000', { credits: 1_000_001 }],
      ['credits as a string', { credits: '250' }],
      ['a negative price', { priceUsdCents: -500 }],
      ['a zero price', { priceUsdCents: 0 }],
      ['a price below $0.50', { priceUsdCents: 49 }],
      ['a price in dollars', { priceUsdCents: 4.99 }],
      ['a fractional price in cents', { priceUsdCents: 499.5 }],
      ['a price above $9,999.99', { priceUsdCents: 1_000_000 }],
      ['a price as a string', { priceUsdCents: '500' }],
      ['availability as a string', { available: 'true' }],
      ['availability as a number', { available: 1 }],
      ['null', { credits: null }],
      ['the read-only dollar price', { priceUsd: '5.00' }],
      ['a code in the body', { code: 'LARGE', credits: 300 }],
      ['an unknown field', { credits: 300, currency: 'EUR' }],
      [
        'one invalid field alongside valid ones',
        { credits: 300, available: false, priceUsdCents: -1 },
      ],
    ])('rejects %s with 400 and persists nothing', async (_case, body) => {
      const response = await patch('SMALL', body).expect(400);
      expect(response.body).toMatchObject({ success: false, statusCode: 400 });
      nothingWritten();
    });

    it.each(['HUGE', 'small', '1'])(
      'answers 404 for the unknown package code %p and persists nothing',
      async (code) => {
        await patch(code, { credits: 300 }).expect(404);
        nothingWritten();
      },
    );

    it.each([
      ['the minimums', { credits: 1, priceUsdCents: 50, available: false }],
      [
        'the maximums',
        { credits: 1_000_000, priceUsdCents: 999_999, available: true },
      ],
    ])('accepts %s', async (_case, body) => {
      await patch('MEDIUM', body).expect(200);
      expect(prisma.creditPackage.update.mock.calls).toHaveLength(1);
    });
  });
});
