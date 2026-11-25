import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, userRole, userStatus } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { CreditModule } from '../src/credit/credit.module';
import { RateLimitStore } from '../src/infrastructure/rate-limit/rate-limit.store';
import {
  NoopTokenVersionCache,
  TokenVersionCache,
} from '../src/infrastructure/token-version/token-version.cache';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';

jest.setTimeout(120_000);

const ROUTE = '/v1/admin/credit-settings';

type Data = Record<string, unknown>;

/** A CreditSettings row as stored in PostgreSQL. */
interface CreditSettingsRow {
  id: string;
  trialAllowanceCredits: number;
  proMonthlyAllowanceCredits: number;
  openRouterUsdMicrosPerCredit: number;
  sessionOverageAllowanceCredits: number;
  createdAt: Date;
  updatedAt: Date;
}

const DEFAULTS = {
  trialAllowanceCredits: 50,
  proMonthlyAllowanceCredits: 1000,
  openRouterUsdMicrosPerCredit: 5000,
  sessionOverageAllowanceCredits: 5,
};

/**
 * AI credit settings administration, end to end: real HTTP requests through
 * the production guards, validation pipe, exception filter and response
 * envelope, against a fully migrated PostgreSQL schema. Authentication runs
 * in PostgreSQL-only mode (no token-version cache), so token versions and
 * account status are read from `authUser`. No Redis, Stripe, OpenRouter or
 * SMTP is involved.
 *
 * Runs only when TEST_DATABASE_URL is set (skipped otherwise); builds a
 * temporary schema from the migration files and drops it afterwards.
 */
describeWithDatabase('AI credit settings (PostgreSQL, full stack)', () => {
  let schema: string;
  /** Independent connection used to arrange and inspect PostgreSQL records. */
  let db: PrismaClient;
  /** The API's own Prisma client; replaced on every restart. */
  let apiClient: PrismaClient | undefined;
  let app: INestApplication<App> | undefined;
  let originalSecret: string;
  let stateAfterMigrations: Awaited<ReturnType<typeof storedState>>;
  const tokens = new AuthUtilsService(mock<RateLimitStore>());

  const connect = () =>
    new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: TEST_DATABASE_URL as string,
          // Raw SQL (row locks, direct checks) resolves tables via search_path.
          options: `-c search_path=${schema}`,
        },
        { schema },
      ),
    });

  /** Boots the API the way main.ts does, with a fresh connection pool. */
  const startApi = async () => {
    apiClient = connect();

    @Global()
    @Module({
      providers: [
        { provide: PrismaService, useValue: apiClient },
        { provide: CustomLoggerService, useValue: mock<CustomLoggerService>() },
        { provide: TokenVersionCache, useClass: NoopTokenVersionCache },
      ],
      exports: [PrismaService, CustomLoggerService, TokenVersionCache],
    })
    class PostgresOnlyInfrastructureModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [PostgresOnlyInfrastructureModule, CreditModule],
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
    await app.listen(0, '127.0.0.1');
  };

  const stopApi = async () => {
    await app?.close();
    await apiClient?.$disconnect();
    app = undefined;
    apiClient = undefined;
  };

  /** Simulates an application restart: nothing survives except PostgreSQL. */
  const restartApi = async () => {
    await stopApi();
    await startApi();
  };

  const http = () => request((app as INestApplication<App>).getHttpServer());
  const dataOf = (response: { body: unknown }) =>
    (response.body as { data: Data }).data;

  const createAccount = async (
    role: userRole,
    status: userStatus = userStatus.ACTIVE,
  ) => {
    const tag = randomBytes(6).toString('hex');
    return db.authUser.create({
      data: {
        email: `${tag}@example.com`,
        username: `credit_${tag}`,
        password: 'not-a-real-hash',
        verified: true,
        role,
        status,
      },
      select: { id: true, role: true, tokenVersion: true },
    });
  };

  const bearerFor = (account: {
    id: string;
    role: string;
    tokenVersion: number;
  }) =>
    `Bearer ${tokens.createAccessToken({
      userId: account.id,
      role: account.role as UserRole,
      tokenVersion: account.tokenVersion,
    })}`;

  const getSettings = (auth?: string) => {
    const req = http().get(ROUTE);
    return auth ? req.set('Authorization', auth) : req;
  };
  const patchSettings = (body: unknown, auth?: string) => {
    const req = http().patch(ROUTE).set('User-Agent', 'credit-e2e');
    return (auth ? req.set('Authorization', auth) : req).send(body as object);
  };

  /** The configuration rows, read directly with SQL. */
  const settingsRows = () =>
    db.$queryRaw<CreditSettingsRow[]>`
      SELECT "id", "trialAllowanceCredits", "proMonthlyAllowanceCredits",
             "openRouterUsdMicrosPerCredit", "sessionOverageAllowanceCredits",
             "createdAt", "updatedAt"
      FROM "CreditSettings"`;
  /** The seed migration, exactly as a deployment runs it. */
  const seedMigration = readFileSync(
    join(
      __dirname,
      '..',
      'prisma',
      'migrations',
      '20261123120000_seed_credit_settings',
      'migration.sql',
    ),
    'utf8',
  );
  const auditEvents = () =>
    db.activityLogEvent.findMany({
      where: { tableName: 'CreditSettings' },
      orderBy: { createdAt: 'asc' },
      select: {
        recordId: true,
        action: true,
        actionedBy: true,
        userAgent: true,
        details: {
          select: { fieldName: true, oldValue: true, newValue: true },
          orderBy: { fieldName: 'asc' },
        },
      },
    });
  /** Everything a rejected request must leave untouched. */
  const storedState = async () => ({
    rows: await settingsRows(),
    audit: await auditEvents(),
  });

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'credit-settings-e2e-secret';
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    db = connect();
    // Captured before the API starts and before any administrator action.
    stateAfterMigrations = await storedState();
    await startApi();
  });

  afterAll(async () => {
    await stopApi();
    await db?.$disconnect();
    if (schema) await dropSchema(schema);
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(async () => {
    // Each test starts like a fresh installation: only the seeded defaults.
    await db.$executeRaw`DELETE FROM "CreditSettings"`;
    await db.$executeRawUnsafe(seedMigration);
    await db.activityLogEvent.deleteMany({
      where: { tableName: 'CreditSettings' },
    });
  });

  describe('default values stored in PostgreSQL', () => {
    const defaultRow: unknown = expect.objectContaining({
      id: 'default',
      ...DEFAULTS,
    });

    it('are stored by the migrations, before the API starts or any administrator change', () => {
      expect(stateAfterMigrations.rows).toEqual([defaultRow]);
      expect(stateAfterMigrations.audit).toEqual([]);
    });

    it('are served from the stored row', async () => {
      const admin = await createAccount(userRole.ADMIN);
      const [row] = await settingsRows();

      const response = await getSettings(bearerFor(admin)).expect(200);

      expect(response.body).toEqual({
        statusCode: 200,
        message: 'Success',
        data: {
          ...DEFAULTS,
          openRouterUsdPerCredit: '0.005',
          updatedAt: row.updatedAt.toISOString(),
        },
      });
      await expect(settingsRows()).resolves.toEqual([row]);
    });

    it('are stored again at startup if the row is missing', async () => {
      await db.$executeRaw`DELETE FROM "CreditSettings"`;

      await restartApi();

      await expect(settingsRows()).resolves.toEqual([defaultRow]);
    });

    it('are re-stored if the row disappears while the API is running', async () => {
      const admin = await createAccount(userRole.ADMIN);
      await db.$executeRaw`DELETE FROM "CreditSettings"`;

      await expect(
        getSettings(bearerFor(admin)).then(dataOf),
      ).resolves.toMatchObject(DEFAULTS);
      await expect(settingsRows()).resolves.toEqual([defaultRow]);
    });

    it('never overwrite administrator changes: not at startup, and not by re-running the seed', async () => {
      const admin = await createAccount(userRole.ADMIN);
      const changed = {
        trialAllowanceCredits: 20,
        proMonthlyAllowanceCredits: 800,
        openRouterUsdMicrosPerCredit: 6000,
        sessionOverageAllowanceCredits: 2,
      };
      await patchSettings(changed, bearerFor(admin)).expect(200);
      const saved = await settingsRows();
      expect(saved).toEqual([expect.objectContaining(changed)]);

      await restartApi();
      await restartApi();
      await db.$executeRawUnsafe(seedMigration);

      await expect(settingsRows()).resolves.toEqual(saved);
      await expect(
        getSettings(bearerFor(admin)).then(dataOf),
      ).resolves.toMatchObject(changed);
    });
  });

  describe('administrator access', () => {
    it.each([userRole.ADMIN, userRole.SUPERADMIN])(
      '%s can read and change the settings',
      async (role) => {
        const admin = await createAccount(role);

        await getSettings(bearerFor(admin)).expect(200);
        const response = await patchSettings(
          { trialAllowanceCredits: 75 },
          bearerFor(admin),
        ).expect(200);

        expect(dataOf(response)).toMatchObject({ trialAllowanceCredits: 75 });
        await expect(settingsRows()).resolves.toEqual([
          expect.objectContaining({ trialAllowanceCredits: 75 }),
        ]);
        await expect(auditEvents()).resolves.toEqual([
          expect.objectContaining({ actionedBy: admin.id }),
        ]);
      },
    );
  });

  describe('rejected requests', () => {
    /** Gives the settings non-default stored values to protect. */
    const configure = async () => {
      const admin = await createAccount(userRole.ADMIN);
      await patchSettings(
        {
          trialAllowanceCredits: 40,
          proMonthlyAllowanceCredits: 1200,
          openRouterUsdMicrosPerCredit: 4000,
          sessionOverageAllowanceCredits: 3,
        },
        bearerFor(admin),
      ).expect(200);
      return admin;
    };

    it.each([userRole.USER, userRole.MODERATOR])(
      'a %s can neither read nor change the settings (403)',
      async (role) => {
        await configure();
        const account = await createAccount(role);
        const before = await storedState();

        const read = await getSettings(bearerFor(account)).expect(403);
        expect(read.body).toMatchObject({
          success: false,
          statusCode: 403,
          message: 'Insufficient permissions',
        });
        expect(read.body).not.toHaveProperty('data');
        await patchSettings(
          { trialAllowanceCredits: 1_000_000 },
          bearerFor(account),
        ).expect(403);
        await patchSettings(
          {
            proMonthlyAllowanceCredits: 999_999,
            sessionOverageAllowanceCredits: 10_000,
          },
          bearerFor(account),
        ).expect(403);

        await expect(storedState()).resolves.toEqual(before);
      },
    );

    it('refuses requests without a valid, current access token (401)', async () => {
      const admin = await configure();
      const before = await storedState();
      const body = { openRouterUsdMicrosPerCredit: 1 };

      // No token, or not a bearer token.
      await getSettings().expect(401);
      await patchSettings(body).expect(401);
      await patchSettings(body, 'Basic YWRtaW46YWRtaW4=').expect(401);
      await patchSettings(body, 'Bearer not-a-jwt').expect(401);

      // An administrator token signed with another secret.
      const secret = config.jwt_access_secret;
      config.jwt_access_secret = 'attacker-secret';
      const forged = bearerFor({ ...admin, role: userRole.SUPERADMIN });
      config.jwt_access_secret = secret;
      await getSettings(forged).expect(401);
      await patchSettings(body, forged).expect(401);

      // An expired administrator token.
      const expired = tokens.createAccessToken(
        { userId: admin.id, role: UserRole.ADMIN, tokenVersion: 1 },
        -1,
      );
      await patchSettings(body, `Bearer ${expired}`).expect(401);

      // A token for an account that does not exist.
      await patchSettings(
        body,
        bearerFor({
          id: 'missing-user',
          role: userRole.ADMIN,
          tokenVersion: 1,
        }),
      ).expect(401);

      await expect(storedState()).resolves.toEqual(before);
    });

    it('refuses an administrator token revoked in PostgreSQL or belonging to an inactive account (401)', async () => {
      await configure();
      const revoked = await createAccount(userRole.ADMIN);
      const staleToken = bearerFor(revoked);
      await db.authUser.update({
        where: { id: revoked.id },
        data: { tokenVersion: { increment: 1 } }, // e.g. logout from all devices
      });
      const suspended = await createAccount(
        userRole.SUPERADMIN,
        userStatus.SUSPENDED,
      );
      const before = await storedState();

      for (const auth of [staleToken, bearerFor(suspended)]) {
        await getSettings(auth).expect(401);
        await patchSettings({ trialAllowanceCredits: 0 }, auth).expect(401);
      }

      await expect(storedState()).resolves.toEqual(before);
    });

    it.each([
      ['an empty body', {}],
      ['a negative trial allowance', { trialAllowanceCredits: -50 }],
      ['a negative Pro monthly allowance', { proMonthlyAllowanceCredits: -1 }],
      ['a negative cost per credit', { openRouterUsdMicrosPerCredit: -5000 }],
      ['a zero cost per credit', { openRouterUsdMicrosPerCredit: 0 }],
      ['a negative session overage', { sessionOverageAllowanceCredits: -5 }],
      ['a cost given in dollars', { openRouterUsdMicrosPerCredit: 0.005 }],
      ['a fractional allowance', { proMonthlyAllowanceCredits: 999.5 }],
      ['a numeric string', { trialAllowanceCredits: '50' }],
      ['null', { sessionOverageAllowanceCredits: null }],
      ['a boolean', { trialAllowanceCredits: true }],
      ['an object', { proMonthlyAllowanceCredits: { $gt: 0 } }],
      ['an array', { trialAllowanceCredits: [50] }],
      [
        'an allowance above 1,000,000',
        { proMonthlyAllowanceCredits: 1_000_001 },
      ],
      [
        'a cost above $1 per credit',
        { openRouterUsdMicrosPerCredit: 1_000_001 },
      ],
      ['an overage above 10,000', { sessionOverageAllowanceCredits: 10_001 }],
      ['a value beyond the integer range', { trialAllowanceCredits: 1e20 }],
      ['the read-only dollar rendering', { openRouterUsdPerCredit: '0.001' }],
      ['a timestamp', { trialAllowanceCredits: 60, updatedAt: '2020-01-01' }],
      ['an unknown field', { trialAllowanceCredits: 60, userCredits: 1000 }],
      [
        'an invalid field next to valid ones',
        {
          trialAllowanceCredits: 60,
          proMonthlyAllowanceCredits: 2000,
          sessionOverageAllowanceCredits: -1,
        },
      ],
    ])(
      'rejects %s with 400 and keeps the stored settings',
      async (_case, body) => {
        const admin = await configure();
        const before = await storedState();

        const response = await patchSettings(body, bearerFor(admin)).expect(
          400,
        );

        expect(response.body).toMatchObject({
          success: false,
          statusCode: 400,
        });
        await expect(storedState()).resolves.toEqual(before);
        await expect(
          getSettings(bearerFor(admin)).then(dataOf),
        ).resolves.toMatchObject({
          trialAllowanceCredits: 40,
          proMonthlyAllowanceCredits: 1200,
          openRouterUsdMicrosPerCredit: 4000,
          sessionOverageAllowanceCredits: 3,
        });
      },
    );

    it.each([
      [
        'a JSON array body',
        '[{"trialAllowanceCredits":60}]',
        'application/json',
      ],
      ['a JSON null body', 'null', 'application/json'],
      ['malformed JSON', '{"trialAllowanceCredits":', 'application/json'],
      [
        'a form-encoded body',
        'trialAllowanceCredits=60',
        'application/x-www-form-urlencoded',
      ],
    ])(
      'rejects %s with 400 and keeps the stored settings',
      async (_case, raw, contentType) => {
        const admin = await configure();
        const before = await storedState();

        await http()
          .patch(ROUTE)
          .set('Authorization', bearerFor(admin))
          .set('Content-Type', contentType)
          .send(raw)
          .expect(400);

        await expect(storedState()).resolves.toEqual(before);
      },
    );

    it.each(['put', 'post', 'delete'] as const)(
      'exposes no %s route for the settings',
      async (method) => {
        const admin = await configure();
        const before = await storedState();

        await http()
          [method](ROUTE)
          .set('Authorization', bearerFor(admin))
          .send({ trialAllowanceCredits: 1 })
          .expect(404);

        await expect(storedState()).resolves.toEqual(before);
      },
    );

    it('PostgreSQL itself rejects negative values and a second configuration row', async () => {
      await configure();
      const before = await storedState();

      for (const column of [
        'trialAllowanceCredits',
        'proMonthlyAllowanceCredits',
        'sessionOverageAllowanceCredits',
      ]) {
        await expect(
          db.$executeRawUnsafe(
            `UPDATE "${schema}"."CreditSettings" SET "${column}" = -1 WHERE "id" = 'default'`,
          ),
        ).rejects.toThrow(/check constraint/i);
      }
      await expect(
        db.$executeRaw`UPDATE "CreditSettings" SET "openRouterUsdMicrosPerCredit" = 0`,
      ).rejects.toThrow(/check constraint/i);
      await expect(
        db.$executeRaw`INSERT INTO "CreditSettings" ("id", "updatedAt") VALUES ('second', now())`,
      ).rejects.toThrow(/check constraint/i);

      await expect(storedState()).resolves.toEqual(before);
    });
  });

  describe('successful updates', () => {
    it('applies partial updates, leaves the other settings unchanged and audits each change', async () => {
      const admin = await createAccount(userRole.ADMIN);
      const auth = bearerFor(admin);

      await patchSettings({ trialAllowanceCredits: 60 }, auth).expect(200);
      const response = await patchSettings(
        {
          openRouterUsdMicrosPerCredit: 2500,
          proMonthlyAllowanceCredits: 1500,
        },
        auth,
      ).expect(200);

      const data = dataOf(response);
      expect(data).toEqual({
        trialAllowanceCredits: 60,
        proMonthlyAllowanceCredits: 1500,
        openRouterUsdMicrosPerCredit: 2500,
        openRouterUsdPerCredit: '0.0025',
        sessionOverageAllowanceCredits: 5,
        updatedAt: expect.any(String) as unknown,
      });

      const [row] = await settingsRows();
      expect(row).toMatchObject({
        id: 'default',
        trialAllowanceCredits: 60,
        proMonthlyAllowanceCredits: 1500,
        openRouterUsdMicrosPerCredit: 2500,
        sessionOverageAllowanceCredits: 5,
      });
      expect(data.updatedAt).toBe(row.updatedAt.toISOString());

      await expect(auditEvents()).resolves.toEqual([
        {
          recordId: 'default',
          action: 'update',
          actionedBy: admin.id,
          userAgent: 'credit-e2e',
          details: [
            {
              fieldName: 'trialAllowanceCredits',
              oldValue: '50',
              newValue: '60',
            },
          ],
        },
        {
          recordId: 'default',
          action: 'update',
          actionedBy: admin.id,
          userAgent: 'credit-e2e',
          details: [
            {
              fieldName: 'openRouterUsdMicrosPerCredit',
              oldValue: '5000',
              newValue: '2500',
            },
            {
              fieldName: 'proMonthlyAllowanceCredits',
              oldValue: '1000',
              newValue: '1500',
            },
          ],
        },
      ]);
    });

    it('accepts every field at once, including zero allowances and the bounds', async () => {
      const admin = await createAccount(userRole.SUPERADMIN);
      const all = {
        trialAllowanceCredits: 0,
        proMonthlyAllowanceCredits: 1_000_000,
        openRouterUsdMicrosPerCredit: 1,
        sessionOverageAllowanceCredits: 0,
      };

      const response = await patchSettings(all, bearerFor(admin)).expect(200);

      expect(dataOf(response)).toMatchObject({
        ...all,
        openRouterUsdPerCredit: '0.000001',
      });
      await expect(settingsRows()).resolves.toEqual([
        expect.objectContaining(all),
      ]);
    });

    it('does not add an audit event when a save changes nothing', async () => {
      const admin = await createAccount(userRole.ADMIN);
      await patchSettings(
        { trialAllowanceCredits: 60 },
        bearerFor(admin),
      ).expect(200);

      await patchSettings(
        { trialAllowanceCredits: 60 },
        bearerFor(admin),
      ).expect(200);

      await expect(auditEvents()).resolves.toHaveLength(1);
    });

    it('applies concurrent updates one at a time, with an accurate audit trail', async () => {
      const admin = await createAccount(userRole.ADMIN);
      const values = [10, 20, 30, 40, 60];

      const responses = await Promise.all(
        values.map((trial) =>
          patchSettings({ trialAllowanceCredits: trial }, bearerFor(admin)),
        ),
      );

      expect(responses.map((r) => r.status)).toEqual(values.map(() => 200));
      const rows = await settingsRows();
      expect(rows).toHaveLength(1);
      // Each audit event's old value is the previous event's new value,
      // starting from the default and ending at the stored value.
      const changes = (await auditEvents()).map((event) => event.details[0]);
      expect(changes).toHaveLength(values.length);
      expect(changes[0].oldValue).toBe('50');
      for (let i = 1; i < changes.length; i++) {
        expect(changes[i].oldValue).toBe(changes[i - 1].newValue);
      }
      expect(changes[changes.length - 1].newValue).toBe(
        String(rows[0].trialAllowanceCredits),
      );
    });
  });

  describe('persistence', () => {
    it('keeps saved settings across application restarts', async () => {
      const admin = await createAccount(userRole.ADMIN);
      const saved = {
        trialAllowanceCredits: 80,
        proMonthlyAllowanceCredits: 2000,
        openRouterUsdMicrosPerCredit: 7500,
        sessionOverageAllowanceCredits: 12,
      };
      const response = await patchSettings(saved, bearerFor(admin)).expect(200);
      const savedAt = dataOf(response).updatedAt;
      const rowBefore = await settingsRows();

      await restartApi();

      const afterRestart = await getSettings(bearerFor(admin)).expect(200);
      expect(dataOf(afterRestart)).toEqual({
        ...saved,
        openRouterUsdPerCredit: '0.0075',
        updatedAt: savedAt,
      });
      await expect(settingsRows()).resolves.toEqual(rowBefore);

      // A later partial change is persisted on top and also survives a restart.
      await patchSettings(
        { sessionOverageAllowanceCredits: 0 },
        bearerFor(admin),
      ).expect(200);
      await restartApi();

      await expect(
        getSettings(bearerFor(admin)).then(dataOf),
      ).resolves.toMatchObject({ ...saved, sessionOverageAllowanceCredits: 0 });
    });

    it('keeps the stored defaults unchanged across restarts when nothing was saved', async () => {
      const admin = await createAccount(userRole.ADMIN);
      const before = await settingsRows();

      await restartApi();

      await expect(getSettings(bearerFor(admin)).then(dataOf)).resolves.toEqual(
        {
          ...DEFAULTS,
          openRouterUsdPerCredit: '0.005',
          updatedAt: before[0].updatedAt.toISOString(),
        },
      );
      await expect(settingsRows()).resolves.toEqual(before);
    });
  });
});
