// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { userRole } from '@prisma/client';
import request from 'supertest';
import { DiscountSettingsService } from '../src/discounts/discount-settings.service';
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

const ROUTE = '/v1/admin/discount-settings';
/** The defaults: every offer switched off. */
const DEFAULTS = {
  firstPurchaseDiscountPercent: 0,
  referralDiscountPercent: 0,
  referrerRewardCredits: 0,
};

interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
}
interface DiscountSettingsData {
  firstPurchaseDiscountPercent: number;
  firstPurchaseDiscountActive: boolean;
  referralDiscountPercent: number;
  referralDiscountActive: boolean;
  referrerRewardCredits: number;
  referrerRewardActive: boolean;
  updatedAt: string;
}
const dataOf = (response: { body: unknown }) =>
  (response.body as Envelope<DiscountSettingsData>).data;

/**
 * Discount and referral configuration through the complete application
 * (AppModule, HTTP, real guards and validation) against a migrated
 * PostgreSQL schema. Tokens come from the real login endpoint. A restart is
 * simulated by closing the application and booting a new one, with new
 * database connections, on the same schema.
 */
describeWithDatabase('Discount settings (PostgreSQL, full stack)', () => {
  let schema: string;
  let ctx: TestApplication;
  let admin: SignedInAccount;
  let superadmin: SignedInAccount;
  let user: SignedInAccount;
  let moderator: SignedInAccount;
  /** The stored configuration right after the first boot, before any request. */
  let initialRow: unknown;
  let initialRowCount: number;
  let ipCounter = 0;
  /** A client address per test, so the per-IP rate limits never interfere. */
  let ip: string;
  const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

  const http = () => request(ctx.app.getHttpServer());
  const bearer = (account: SignedInAccount) => `Bearer ${account.accessToken}`;
  const get = (account?: SignedInAccount) => {
    const req = http().get(ROUTE).set('X-Forwarded-For', ip);
    return account ? req.set('Authorization', bearer(account)) : req;
  };
  const patch = (body: unknown, account?: SignedInAccount) => {
    const req = http()
      .patch(ROUTE)
      .set('X-Forwarded-For', ip)
      .set('User-Agent', 'discount-settings-e2e');
    return (account ? req.set('Authorization', bearer(account)) : req).send(
      body as object,
    );
  };

  const storedRow = () =>
    ctx.client.discountSettings.findUnique({ where: { id: 1 } });
  const auditEvents = () =>
    ctx.client.activityLogEvent.findMany({
      where: { tableName: 'DiscountSettings' },
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
  /** Everything a rejected request must leave untouched. */
  const snapshot = async () => ({
    row: await storedRow(),
    rows: await ctx.client.discountSettings.count(),
    audit: await ctx.client.activityLogEvent.count({
      where: { tableName: 'DiscountSettings' },
    }),
  });

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    ctx = await bootApplication({ schema });
    initialRow = await storedRow();
    initialRowCount = await ctx.client.discountSettings.count();
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
    await ctx.client.discountSettings.deleteMany();
    await ctx
      .get<DiscountSettingsService>(DiscountSettingsService)
      .ensureDefaults();
    await ctx.client.activityLogEvent.deleteMany({
      where: { tableName: 'DiscountSettings' },
    });
  });

  describe('default values', () => {
    it('has every offer switched off (0) in PostgreSQL before any administrator change', async () => {
      expect(initialRowCount).toBe(1);
      expect(initialRow).toEqual({
        id: 1,
        ...DEFAULTS,
        createdAt: expect.any(Date) as unknown,
        updatedAt: expect.any(Date) as unknown,
      });

      const row = await storedRow();
      const response = await get(admin).expect(200);
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
          updatedAt: row?.updatedAt.toISOString(),
        },
      });
      // Reading writes nothing.
      await expect(storedRow()).resolves.toEqual(row);
    });

    it('stores the defaults with the migrations alone, before the application ever runs', async () => {
      const fresh = await createSchema();
      try {
        await applyMigrations(fresh, migrationNames());
        const pg = await connectToSchema(fresh);
        try {
          const { rows } = await pg.query<Record<string, unknown>>(
            'SELECT "id", "firstPurchaseDiscountPercent", "referralDiscountPercent", "referrerRewardCredits" FROM "DiscountSettings"',
          );
          expect(rows).toEqual([{ id: 1, ...DEFAULTS }]);
        } finally {
          await pg.end();
        }
      } finally {
        await dropSchema(fresh);
      }
    });

    it('restores a deleted configuration with the defaults when the application starts', async () => {
      await ctx.client.discountSettings.deleteMany();

      await ctx.close();
      ctx = await bootApplication({ schema });

      await expect(ctx.client.discountSettings.count()).resolves.toBe(1);
      await expect(storedRow()).resolves.toMatchObject({ id: 1, ...DEFAULTS });
    });
  });

  describe('permissions', () => {
    it.each([
      ['ADMIN', () => admin],
      ['SUPERADMIN', () => superadmin],
    ])(
      '%s can read and change every setting; each change is stored and attributed',
      async (_role, account) => {
        const changes = [
          { firstPurchaseDiscountPercent: 20 },
          { referralDiscountPercent: 15 },
          { referrerRewardCredits: 250 },
        ];
        for (const body of changes) {
          await patch(body, account()).expect(200);
        }

        expect(dataOf(await get(account()).expect(200))).toMatchObject({
          firstPurchaseDiscountPercent: 20,
          firstPurchaseDiscountActive: true,
          referralDiscountPercent: 15,
          referralDiscountActive: true,
          referrerRewardCredits: 250,
          referrerRewardActive: true,
        });
        await expect(storedRow()).resolves.toMatchObject({
          firstPurchaseDiscountPercent: 20,
          referralDiscountPercent: 15,
          referrerRewardCredits: 250,
        });
        const events = await auditEvents();
        expect(events).toHaveLength(changes.length);
        expect(events.every((e) => e.actionedBy === account().id)).toBe(true);
      },
    );

    it('refuses requests without a token, with an invalid token, or with a non-Bearer scheme', async () => {
      const before = await snapshot();

      await get().expect(401);
      await patch({ referralDiscountPercent: 50 }).expect(401);
      const garbage = { accessToken: 'not-a-jwt', id: 'none' };
      await get(garbage).expect(401);
      await patch({ referralDiscountPercent: 50 }, garbage).expect(401);
      await http()
        .patch(ROUTE)
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Basic ${admin.accessToken}`)
        .send({ referralDiscountPercent: 50 })
        .expect(401);

      await expect(snapshot()).resolves.toEqual(before);
    });

    it.each([
      ['USER', () => user],
      ['MODERATOR', () => moderator],
    ])(
      'a %s can neither read nor change any setting',
      async (_role, account) => {
        await patch({ referralDiscountPercent: 10 }, admin).expect(200);
        const before = await snapshot();

        const read = await get(account()).expect(403);
        expect(read.body).toMatchObject({ success: false, statusCode: 403 });
        expect(JSON.stringify(read.body)).not.toContain('DiscountPercent');
        for (const body of [
          { firstPurchaseDiscountPercent: 100 },
          { referralDiscountPercent: 100 },
          { referrerRewardCredits: 100_000 },
          { referralDiscountPercent: 0 },
        ]) {
          await patch(body, account()).expect(403);
        }

        await expect(snapshot()).resolves.toEqual(before);
      },
    );

    it('refuses an administrator token once it has been revoked', async () => {
      const revoked = await signInWithRole(ctx, userRole.ADMIN, nextIp());
      await get(revoked).expect(200);
      await revokeTokens(ctx, revoked);
      const before = await snapshot();

      await get(revoked).expect(401);
      await patch({ referrerRewardCredits: 10 }, revoked).expect(401);

      await expect(snapshot()).resolves.toEqual(before);
    });
  });

  describe('validation', () => {
    const stored = {
      firstPurchaseDiscountPercent: 10,
      referralDiscountPercent: 5,
      referrerRewardCredits: 100,
    };

    it.each([
      ['an empty body', {}],
      [
        'a negative first-purchase discount',
        { firstPurchaseDiscountPercent: -5 },
      ],
      [
        'a first-purchase discount above 100%',
        { firstPurchaseDiscountPercent: 101 },
      ],
      [
        'a fractional first-purchase discount',
        { firstPurchaseDiscountPercent: 7.5 },
      ],
      ['a percentage given as a fraction', { referralDiscountPercent: 0.15 }],
      ['a negative referral discount', { referralDiscountPercent: -1 }],
      ['a referral discount above 100%', { referralDiscountPercent: 1000 }],
      ['a percentage string', { referralDiscountPercent: '15%' }],
      ['a numeric string', { firstPurchaseDiscountPercent: '15' }],
      ['negative reward credits', { referrerRewardCredits: -100 }],
      ['fractional reward credits', { referrerRewardCredits: 99.5 }],
      ['reward credits above the maximum', { referrerRewardCredits: 100_001 }],
      ['reward credits as a string', { referrerRewardCredits: '100' }],
      ['a boolean', { referrerRewardCredits: false }],
      ['null', { referralDiscountPercent: null }],
      ['a read-only active flag', { firstPurchaseDiscountActive: false }],
      ['an unknown field', { referralDiscountPercent: 10, id: 2 }],
      [
        'one invalid value next to valid ones',
        {
          firstPurchaseDiscountPercent: 30,
          referralDiscountPercent: 30,
          referrerRewardCredits: -1,
        },
      ],
    ])(
      'rejects %s with 400 and keeps the stored configuration',
      async (_case, body) => {
        await patch(stored, admin).expect(200);
        const before = await snapshot();

        const response = await patch(body, admin).expect(400);

        expect(response.body).toMatchObject({
          success: false,
          statusCode: 400,
        });
        await expect(snapshot()).resolves.toEqual(before);
        expect(dataOf(await get(admin).expect(200))).toMatchObject(stored);
      },
    );

    it('has PostgreSQL reject invalid values written outside the API', async () => {
      await patch(stored, admin).expect(200);
      const before = await snapshot();

      for (const [column, value, constraint] of [
        [
          'firstPurchaseDiscountPercent',
          -1,
          'DiscountSettings_firstPurchaseDiscountPercent_range',
        ],
        [
          'firstPurchaseDiscountPercent',
          101,
          'DiscountSettings_firstPurchaseDiscountPercent_range',
        ],
        [
          'referralDiscountPercent',
          101,
          'DiscountSettings_referralDiscountPercent_range',
        ],
        [
          'referrerRewardCredits',
          -1,
          'DiscountSettings_referrerRewardCredits_non_negative',
        ],
      ] as const) {
        await expect(
          ctx.client.discountSettings.update({
            where: { id: 1 },
            data: { [column]: value },
          }),
        ).rejects.toThrow(constraint);
      }
      await expect(
        ctx.client.discountSettings.create({ data: { id: 2 } }),
      ).rejects.toThrow('DiscountSettings_single_row');

      await expect(snapshot()).resolves.toEqual(before);
    });
  });

  describe('updates', () => {
    it('changes only the supplied fields and audits old and new values', async () => {
      const first = await patch(
        { firstPurchaseDiscountPercent: 25 },
        admin,
      ).expect(200);
      expect(dataOf(first)).toEqual({
        firstPurchaseDiscountPercent: 25,
        firstPurchaseDiscountActive: true,
        referralDiscountPercent: 0,
        referralDiscountActive: false,
        referrerRewardCredits: 0,
        referrerRewardActive: false,
        updatedAt: expect.any(String) as unknown,
      });

      await patch(
        { referralDiscountPercent: 10, referrerRewardCredits: 500 },
        superadmin,
      ).expect(200);
      // Saving unchanged values succeeds without a new audit entry.
      const unchanged = await patch(
        { firstPurchaseDiscountPercent: 25 },
        admin,
      ).expect(200);

      const row = await storedRow();
      expect(row).toMatchObject({
        firstPurchaseDiscountPercent: 25,
        referralDiscountPercent: 10,
        referrerRewardCredits: 500,
      });
      expect(dataOf(unchanged).updatedAt).toBe(row?.updatedAt.toISOString());
      await expect(auditEvents()).resolves.toEqual([
        {
          action: 'update',
          actionedBy: admin.id,
          recordId: '1',
          userAgent: 'discount-settings-e2e',
          details: [
            {
              fieldName: 'firstPurchaseDiscountPercent',
              oldValue: '0',
              newValue: '25',
            },
          ],
        },
        {
          action: 'update',
          actionedBy: superadmin.id,
          recordId: '1',
          userAgent: 'discount-settings-e2e',
          details: [
            {
              fieldName: 'referralDiscountPercent',
              oldValue: '0',
              newValue: '10',
            },
            {
              fieldName: 'referrerRewardCredits',
              oldValue: '0',
              newValue: '500',
            },
          ],
        },
      ]);
    });

    it('accepts the boundary values and switches offers off again with 0', async () => {
      const maximums = {
        firstPurchaseDiscountPercent: 100,
        referralDiscountPercent: 100,
        referrerRewardCredits: 100_000,
      };
      await patch(maximums, admin).expect(200);
      await expect(storedRow()).resolves.toMatchObject(maximums);

      const off = await patch(DEFAULTS, superadmin).expect(200);
      expect(dataOf(off)).toMatchObject({
        ...DEFAULTS,
        firstPurchaseDiscountActive: false,
        referralDiscountActive: false,
        referrerRewardActive: false,
      });
      await expect(storedRow()).resolves.toMatchObject(DEFAULTS);
    });

    it('applies concurrent changes one at a time, with an exact audit chain', async () => {
      const values = [5, 10, 15, 20, 25, 30];
      const responses = await Promise.all(
        values.map((percent) =>
          patch({ referralDiscountPercent: percent }, admin),
        ),
      );
      expect(responses.map((r) => r.status)).toEqual(values.map(() => 200));

      await expect(ctx.client.discountSettings.count()).resolves.toBe(1);

      // Each audit entry's old value is the previous entry's new value: the
      // changes form one chain from the default to the stored value
      // (followed by value, since commits may share a timestamp).
      const changes = (await auditEvents()).map((event) => event.details[0]);
      expect(changes).toHaveLength(values.length);
      let current = '0';
      for (let step = 0; step < values.length; step += 1) {
        const next = changes.find((change) => change?.oldValue === current);
        expect(next).toBeDefined();
        current = next?.newValue as string;
      }
      const row = await storedRow();
      expect(String(row?.referralDiscountPercent)).toBe(current);
    });
  });

  describe('persistence', () => {
    it('keeps the saved configuration across an application restart', async () => {
      const saved = {
        firstPurchaseDiscountPercent: 30,
        referralDiscountPercent: 20,
        referrerRewardCredits: 150,
      };
      await patch(saved, admin).expect(200);
      const rowBefore = await storedRow();

      // Restart: startup stores defaults only when no row exists, so it must
      // not touch the administrator's values (not even updatedAt).
      await ctx.close();
      ctx = await bootApplication({ schema });

      await expect(storedRow()).resolves.toEqual(rowBefore);
      await expect(ctx.client.discountSettings.count()).resolves.toBe(1);
      expect(dataOf(await get(superadmin).expect(200))).toEqual({
        ...saved,
        firstPurchaseDiscountActive: true,
        referralDiscountActive: true,
        referrerRewardActive: true,
        updatedAt: rowBefore?.updatedAt.toISOString(),
      });

      // Further partial changes build on the persisted values.
      await patch({ referrerRewardCredits: 0 }, admin).expect(200);
      await ctx.close();
      ctx = await bootApplication({ schema });
      expect(dataOf(await get(admin).expect(200))).toMatchObject({
        ...saved,
        referrerRewardCredits: 0,
        referrerRewardActive: false,
      });
    });
  });
});
