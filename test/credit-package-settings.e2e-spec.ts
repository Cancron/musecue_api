// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { userRole } from '@prisma/client';
import request from 'supertest';
import { CreditPackageSettingsService } from '../src/credit-packages/credit-package-settings.service';
import {
  revokeTokens,
  signInWithRole,
  type SignedInAccount,
} from './support/admin-accounts';
import {
  bootApplication,
  type TestApplication,
} from './support/infrastructure-flows';
import {
  applyMigrations,
  connectToSchema,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';

jest.setTimeout(120_000);

const ROUTE = '/v1/admin/credit-package-settings';
/** 250 credits for $5, 500 for $10 and 1,000 for $20, all available. */
const DEFAULTS = [
  { code: 'SMALL', credits: 250, priceUsdCents: 500, available: true },
  { code: 'MEDIUM', credits: 500, priceUsdCents: 1000, available: true },
  { code: 'LARGE', credits: 1000, priceUsdCents: 2000, available: true },
] as const;

interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
}
interface CreditPackageData {
  code: string;
  currency: string;
  credits: number;
  priceUsdCents: number;
  priceUsd: string;
  available: boolean;
  updatedAt: string;
}
const dataOf = <T = CreditPackageData>(response: { body: unknown }) =>
  (response.body as Envelope<T>).data;

/**
 * Credit package configuration through the complete application (AppModule,
 * HTTP, real guards and validation) against a migrated PostgreSQL schema.
 * Tokens come from the real login endpoint. A restart is simulated by
 * closing the application and booting a new one on the same schema.
 */
describeWithDatabase('Credit package settings (PostgreSQL, full stack)', () => {
  let schema: string;
  let ctx: TestApplication;
  let admin: SignedInAccount;
  let superadmin: SignedInAccount;
  let user: SignedInAccount;
  let moderator: SignedInAccount;
  let initialRows: PackageFields[];
  let ipCounter = 0;
  let ip: string;
  const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

  const http = () => request(ctx.app.getHttpServer());
  const bearer = (account: SignedInAccount) => `Bearer ${account.accessToken}`;
  const get = (path: string, account?: SignedInAccount) => {
    const req = http().get(`${ROUTE}${path}`).set('X-Forwarded-For', ip);
    return account ? req.set('Authorization', bearer(account)) : req;
  };
  const list = (account?: SignedInAccount) => get('', account);
  const patch = (code: string, body: unknown, account?: SignedInAccount) => {
    const req = http()
      .patch(`${ROUTE}/${code}`)
      .set('X-Forwarded-For', ip)
      .set('User-Agent', 'credit-package-settings-e2e');
    return (account ? req.set('Authorization', bearer(account)) : req).send(
      body as object,
    );
  };

  const storedRows = () =>
    ctx.client.creditPackage.findMany({ orderBy: { code: 'asc' } });
  const storedRow = (code: 'SMALL' | 'MEDIUM' | 'LARGE') =>
    ctx.client.creditPackage.findUnique({ where: { code } });
  const auditEvents = () =>
    ctx.client.activityLogEvent.findMany({
      where: { tableName: 'CreditPackage' },
      orderBy: { createdAt: 'asc' },
      select: {
        action: true,
        actionedBy: true,
        recordId: true,
        userAgent: true,
        details: {
          select: { fieldName: true, oldValue: true, newValue: true },
          orderBy: { fieldName: 'asc' },
        },
      },
    });
  const snapshot = async () => ({
    rows: await storedRows(),
    audit: await ctx.client.activityLogEvent.count({
      where: { tableName: 'CreditPackage' },
    }),
  });
  interface PackageFields {
    code: string;
    credits: number;
    priceUsdCents: number;
    available: boolean;
  }
  /** The configurable fields, from stored rows or API responses. */
  const summary = (rows: readonly PackageFields[]) =>
    rows.map(({ code, credits, priceUsdCents, available }) => ({
      code,
      credits,
      priceUsdCents,
      available,
    }));

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    ctx = await bootApplication({ schema });
    initialRows = await storedRows();
    admin = await signInWithRole(ctx, userRole.ADMIN, nextIp());
    superadmin = await signInWithRole(ctx, userRole.SUPERADMIN, nextIp());
    user = await signInWithRole(ctx, userRole.USER, nextIp());
    moderator = await signInWithRole(ctx, userRole.MODERATOR, nextIp());
  });

  afterAll(async () => {
    await ctx?.close();
    if (schema) await dropSchema(schema);
  });

  /** Back to the stored defaults, through the production startup path. */
  beforeEach(async () => {
    ip = nextIp();
    await ctx.client.creditPackage.deleteMany();
    await ctx
      .get<CreditPackageSettingsService>(CreditPackageSettingsService)
      .ensureDefaults();
    await ctx.client.activityLogEvent.deleteMany({
      where: { tableName: 'CreditPackage' },
    });
  });

  describe('default values', () => {
    it('has the three default packages in PostgreSQL before any administrator change', async () => {
      expect(summary(initialRows)).toEqual(DEFAULTS);

      const rows = await storedRows();
      const response = await list(admin).expect(200);
      expect(response.body).toEqual({
        statusCode: 200,
        message: 'Success',
        data: [
          {
            code: 'SMALL',
            currency: 'USD',
            credits: 250,
            priceUsdCents: 500,
            priceUsd: '5.00',
            available: true,
            updatedAt: rows[0]?.updatedAt.toISOString(),
          },
          {
            code: 'MEDIUM',
            currency: 'USD',
            credits: 500,
            priceUsdCents: 1000,
            priceUsd: '10.00',
            available: true,
            updatedAt: rows[1]?.updatedAt.toISOString(),
          },
          {
            code: 'LARGE',
            currency: 'USD',
            credits: 1000,
            priceUsdCents: 2000,
            priceUsd: '20.00',
            available: true,
            updatedAt: rows[2]?.updatedAt.toISOString(),
          },
        ],
      });
      expect(dataOf(await get('/MEDIUM', admin).expect(200))).toMatchObject({
        code: 'MEDIUM',
        credits: 500,
        priceUsdCents: 1000,
        priceUsd: '10.00',
      });
      // Reading writes nothing.
      await expect(storedRows()).resolves.toEqual(rows);
    });

    it('stores the defaults with the migrations alone, before the application ever runs', async () => {
      const fresh = await createSchema();
      try {
        await applyMigrations(fresh, migrationNames());
        const pg = await connectToSchema(fresh);
        try {
          const { rows } = await pg.query<Record<string, unknown>>(
            'SELECT "code", "credits", "priceUsdCents", "available" FROM "CreditPackage" ORDER BY "code"',
          );
          expect(rows).toEqual(DEFAULTS);
        } finally {
          await pg.end();
        }
      } finally {
        await dropSchema(fresh);
      }
    });

    it('restores only a deleted package at startup and keeps the changed ones', async () => {
      await patch('SMALL', { credits: 300 }, admin).expect(200);
      await ctx.client.creditPackage.delete({ where: { code: 'LARGE' } });

      await ctx.close();
      ctx = await bootApplication({ schema });

      expect(summary(await storedRows())).toEqual([
        { ...DEFAULTS[0], credits: 300 },
        DEFAULTS[1],
        DEFAULTS[2],
      ]);
    });
  });

  describe('permissions', () => {
    it.each([
      ['ADMIN', () => admin],
      ['SUPERADMIN', () => superadmin],
    ])(
      '%s can read and change every package; each change is stored and attributed',
      async (_role, account) => {
        await patch('SMALL', { credits: 300 }, account()).expect(200);
        await patch('MEDIUM', { priceUsdCents: 900 }, account()).expect(200);
        await patch('LARGE', { available: false }, account()).expect(200);

        expect(
          summary(
            dataOf<CreditPackageData[]>(await list(account()).expect(200)),
          ),
        ).toEqual([
          { ...DEFAULTS[0], credits: 300 },
          { ...DEFAULTS[1], priceUsdCents: 900 },
          { ...DEFAULTS[2], available: false },
        ]);
        expect(summary(await storedRows())).toEqual([
          { ...DEFAULTS[0], credits: 300 },
          { ...DEFAULTS[1], priceUsdCents: 900 },
          { ...DEFAULTS[2], available: false },
        ]);
        const events = await auditEvents();
        expect(events.map((e) => e.recordId).sort()).toEqual([
          'LARGE',
          'MEDIUM',
          'SMALL',
        ]);
        expect(events.every((e) => e.actionedBy === account().id)).toBe(true);
      },
    );

    it('refuses requests without a token, with an invalid token, or with a non-Bearer scheme', async () => {
      const before = await snapshot();

      await list().expect(401);
      await get('/SMALL').expect(401);
      await patch('SMALL', { credits: 1 }).expect(401);
      const garbage = { accessToken: 'not-a-jwt', id: 'none' };
      await list(garbage).expect(401);
      await patch('SMALL', { credits: 1 }, garbage).expect(401);
      await http()
        .patch(`${ROUTE}/SMALL`)
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Basic ${admin.accessToken}`)
        .send({ credits: 1 })
        .expect(401);

      await expect(snapshot()).resolves.toEqual(before);
    });

    it.each([
      ['USER', () => user],
      ['MODERATOR', () => moderator],
    ])(
      'a %s can neither read nor change any package',
      async (_role, account) => {
        await patch('MEDIUM', { priceUsdCents: 1200 }, admin).expect(200);
        const before = await snapshot();

        const read = await list(account()).expect(403);
        expect(read.body).toMatchObject({ success: false, statusCode: 403 });
        expect(JSON.stringify(read.body)).not.toContain('priceUsdCents');
        await get('/SMALL', account()).expect(403);
        for (const [code, body] of [
          ['SMALL', { priceUsdCents: 50 }],
          ['MEDIUM', { credits: 1_000_000 }],
          ['LARGE', { available: false }],
        ] as const) {
          await patch(code, body, account()).expect(403);
        }

        await expect(snapshot()).resolves.toEqual(before);
      },
    );

    it('refuses an administrator token once it has been revoked', async () => {
      const revoked = await signInWithRole(ctx, userRole.ADMIN, nextIp());
      await list(revoked).expect(200);
      await revokeTokens(ctx, revoked);
      const before = await snapshot();

      await list(revoked).expect(401);
      await patch('SMALL', { priceUsdCents: 100 }, revoked).expect(401);

      await expect(snapshot()).resolves.toEqual(before);
    });
  });

  describe('validation', () => {
    const stored = { credits: 275, priceUsdCents: 550, available: true };

    it.each([
      ['an empty body', {}],
      ['negative credits', { credits: -250 }],
      ['zero credits', { credits: 0 }],
      ['fractional credits', { credits: 250.5 }],
      ['credits above the maximum', { credits: 1_000_001 }],
      ['credits as a string', { credits: '250' }],
      ['a negative price', { priceUsdCents: -500 }],
      ['a zero price', { priceUsdCents: 0 }],
      ['a price below $0.50', { priceUsdCents: 49 }],
      ['the price given in dollars', { priceUsdCents: 5.5 }],
      ['a fractional price in cents', { priceUsdCents: 549.99 }],
      ['a price above $9,999.99', { priceUsdCents: 1_000_000 }],
      ['the price as a string', { priceUsdCents: '550' }],
      ['availability as a string', { available: 'false' }],
      ['availability as a number', { available: 0 }],
      ['null', { priceUsdCents: null }],
      ['the read-only dollar price', { priceUsd: '5.50' }],
      ['a currency', { currency: 'EUR' }],
      ['a package code in the body', { code: 'LARGE', credits: 300 }],
      [
        'one invalid value next to valid ones',
        { credits: 400, available: false, priceUsdCents: -1 },
      ],
    ])(
      'rejects %s with 400 and keeps every stored package',
      async (_case, body) => {
        await patch('SMALL', stored, admin).expect(200);
        const before = await snapshot();

        const response = await patch('SMALL', body, admin).expect(400);

        expect(response.body).toMatchObject({
          success: false,
          statusCode: 400,
        });
        await expect(snapshot()).resolves.toEqual(before);
        expect(dataOf(await get('/SMALL', admin).expect(200))).toMatchObject(
          stored,
        );
      },
    );

    it.each(['HUGE', 'small', 'XL', '1'])(
      'answers 404 for the unknown package %p and changes nothing',
      async (code) => {
        const before = await snapshot();

        await get(`/${code}`, admin).expect(404);
        const response = await patch(code, { credits: 300 }, admin).expect(404);
        expect(response.body).toMatchObject({
          success: false,
          statusCode: 404,
          message: 'Credit package not found',
        });

        await expect(snapshot()).resolves.toEqual(before);
      },
    );

    it('has PostgreSQL reject invalid packages written outside the API', async () => {
      const before = await snapshot();

      for (const [data, constraint] of [
        [{ credits: 0 }, 'CreditPackage_credits_positive'],
        [{ credits: -1 }, 'CreditPackage_credits_positive'],
        [{ priceUsdCents: 0 }, 'CreditPackage_priceUsdCents_positive'],
      ] as const) {
        await expect(
          ctx.client.creditPackage.update({ where: { code: 'SMALL' }, data }),
        ).rejects.toThrow(constraint);
      }
      // Only the fixed package codes exist.
      await expect(
        ctx.client.$executeRawUnsafe(
          `INSERT INTO "CreditPackage" ("code", "credits", "priceUsdCents", "updatedAt")
           VALUES ('HUGE', 5000, 9000, now())`,
        ),
      ).rejects.toThrow(/CreditPackageCode/);

      await expect(snapshot()).resolves.toEqual(before);
    });
  });

  describe('updates', () => {
    it('changes only the supplied fields of the addressed package and audits old and new values', async () => {
      const first = await patch('MEDIUM', { credits: 600 }, admin).expect(200);
      expect(dataOf(first)).toEqual({
        code: 'MEDIUM',
        currency: 'USD',
        credits: 600,
        priceUsdCents: 1000,
        priceUsd: '10.00',
        available: true,
        updatedAt: expect.any(String) as unknown,
      });

      await patch(
        'MEDIUM',
        { priceUsdCents: 1199, available: false },
        superadmin,
      ).expect(200);
      // Saving unchanged values succeeds without a new audit entry.
      const unchanged = await patch('MEDIUM', { credits: 600 }, admin).expect(
        200,
      );

      expect(summary(await storedRows())).toEqual([
        DEFAULTS[0],
        { code: 'MEDIUM', credits: 600, priceUsdCents: 1199, available: false },
        DEFAULTS[2],
      ]);
      const row = await storedRow('MEDIUM');
      expect(dataOf(unchanged)).toMatchObject({
        priceUsd: '11.99',
        updatedAt: row?.updatedAt.toISOString(),
      });
      await expect(auditEvents()).resolves.toEqual([
        {
          action: 'update',
          actionedBy: admin.id,
          recordId: 'MEDIUM',
          userAgent: 'credit-package-settings-e2e',
          details: [{ fieldName: 'credits', oldValue: '500', newValue: '600' }],
        },
        {
          action: 'update',
          actionedBy: superadmin.id,
          recordId: 'MEDIUM',
          userAgent: 'credit-package-settings-e2e',
          details: [
            { fieldName: 'available', oldValue: 'true', newValue: 'false' },
            {
              fieldName: 'priceUsdCents',
              oldValue: '1000',
              newValue: '1199',
            },
          ],
        },
      ]);
    });

    it('withdraws a package from sale and offers it again', async () => {
      await patch('LARGE', { available: false }, admin).expect(200);
      expect(dataOf(await get('/LARGE', admin).expect(200))).toMatchObject({
        available: false,
      });
      await patch('LARGE', { available: true }, superadmin).expect(200);
      await expect(storedRow('LARGE')).resolves.toMatchObject({
        available: true,
      });
    });

    it('accepts the boundary values', async () => {
      const minimums = { credits: 1, priceUsdCents: 50, available: false };
      const maximums = {
        credits: 1_000_000,
        priceUsdCents: 999_999,
        available: true,
      };
      const lowest = await patch('SMALL', minimums, admin).expect(200);
      expect(dataOf(lowest)).toMatchObject({ priceUsd: '0.50' });
      await expect(storedRow('SMALL')).resolves.toMatchObject(minimums);
      const highest = await patch('SMALL', maximums, superadmin).expect(200);
      expect(dataOf(highest)).toMatchObject({ priceUsd: '9999.99' });
      await expect(storedRow('SMALL')).resolves.toMatchObject(maximums);
    });

    it('applies concurrent changes to one package one at a time, with an exact audit chain', async () => {
      const values = [600, 700, 800, 900, 1100];
      const responses = await Promise.all(
        values.map((cents) => patch('SMALL', { priceUsdCents: cents }, admin)),
      );
      expect(responses.map((r) => r.status)).toEqual(values.map(() => 200));
      await expect(ctx.client.creditPackage.count()).resolves.toBe(3);

      const changes = (await auditEvents()).map((event) => event.details[0]);
      expect(changes).toHaveLength(values.length);
      let current = '500';
      for (let step = 0; step < values.length; step += 1) {
        const next = changes.find((change) => change?.oldValue === current);
        expect(next).toBeDefined();
        current = next?.newValue as string;
      }
      const row = await storedRow('SMALL');
      expect(String(row?.priceUsdCents)).toBe(current);
    });
  });

  describe('persistence', () => {
    it('keeps the saved packages across an application restart', async () => {
      await patch('SMALL', { credits: 200, priceUsdCents: 399 }, admin).expect(
        200,
      );
      await patch('LARGE', { available: false }, superadmin).expect(200);
      const rowsBefore = await storedRows();

      // Restart: startup inserts only missing packages, so it must not touch
      // the administrator's values (not even updatedAt).
      await ctx.close();
      ctx = await bootApplication({ schema });

      await expect(storedRows()).resolves.toEqual(rowsBefore);
      const packages = dataOf<CreditPackageData[]>(
        await list(admin).expect(200),
      );
      expect(packages).toEqual([
        {
          code: 'SMALL',
          currency: 'USD',
          credits: 200,
          priceUsdCents: 399,
          priceUsd: '3.99',
          available: true,
          updatedAt: rowsBefore[0]?.updatedAt.toISOString(),
        },
        {
          code: 'MEDIUM',
          currency: 'USD',
          credits: 500,
          priceUsdCents: 1000,
          priceUsd: '10.00',
          available: true,
          updatedAt: rowsBefore[1]?.updatedAt.toISOString(),
        },
        {
          code: 'LARGE',
          currency: 'USD',
          credits: 1000,
          priceUsdCents: 2000,
          priceUsd: '20.00',
          available: false,
          updatedAt: rowsBefore[2]?.updatedAt.toISOString(),
        },
      ]);
    });
  });
});
