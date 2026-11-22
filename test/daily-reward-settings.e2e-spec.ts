// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { userRole } from '@prisma/client';
import request from 'supertest';
import { DailyRewardSettingsService } from '../src/daily-rewards/daily-reward-settings.service';
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

const ROUTE = '/v1/admin/daily-reward-settings';
const DEFAULTS = {
  startingRewardCredits: 10,
  dailyIncrementCredits: 10,
  maxDailyRewardCredits: 50,
};
const MONTHLY_CAP = 600;

interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
}
interface DailyRewardSettingsData {
  startingRewardCredits: number;
  dailyIncrementCredits: number;
  maxDailyRewardCredits: number;
  monthlyCapCredits: number;
  updatedAt: string;
}
const dataOf = (response: { body: unknown }) =>
  (response.body as Envelope<DailyRewardSettingsData>).data;

/**
 * Daily reward configuration through the complete application (AppModule,
 * HTTP, real guards and validation) against a migrated PostgreSQL schema.
 * Tokens come from the real login endpoint. A restart is simulated by
 * closing the application and booting a new one on the same schema.
 */
describeWithDatabase('Daily reward settings (PostgreSQL, full stack)', () => {
  let schema: string;
  let ctx: TestApplication;
  let admin: SignedInAccount;
  let superadmin: SignedInAccount;
  let user: SignedInAccount;
  let moderator: SignedInAccount;
  let initialRow: unknown;
  let initialRowCount: number;
  let ipCounter = 0;
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
      .set('User-Agent', 'daily-reward-settings-e2e');
    return (account ? req.set('Authorization', bearer(account)) : req).send(
      body as object,
    );
  };

  const storedRow = () =>
    ctx.client.dailyRewardSettings.findUnique({ where: { id: 1 } });
  const auditEvents = () =>
    ctx.client.activityLogEvent.findMany({
      where: { tableName: 'DailyRewardSettings' },
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
    row: await storedRow(),
    rows: await ctx.client.dailyRewardSettings.count(),
    audit: await ctx.client.activityLogEvent.count({
      where: { tableName: 'DailyRewardSettings' },
    }),
  });

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    ctx = await bootApplication({ schema });
    initialRow = await storedRow();
    initialRowCount = await ctx.client.dailyRewardSettings.count();
    admin = await signInWithRole(ctx, userRole.ADMIN, nextIp());
    superadmin = await signInWithRole(ctx, userRole.SUPERADMIN, nextIp());
    user = await signInWithRole(ctx, userRole.USER, nextIp());
    moderator = await signInWithRole(ctx, userRole.MODERATOR, nextIp());
  });

  afterAll(async () => {
    await ctx?.close();
    if (schema) await dropSchema(schema);
  });

  beforeEach(async () => {
    ip = nextIp();
    await ctx.client.dailyRewardSettings.deleteMany();
    await ctx
      .get<DailyRewardSettingsService>(DailyRewardSettingsService)
      .ensureDefaults();
    await ctx.client.activityLogEvent.deleteMany({
      where: { tableName: 'DailyRewardSettings' },
    });
  });

  describe('default values', () => {
    it('has 10 credits rising by 10 up to 50 in PostgreSQL, with the 600-credit monthly cap', async () => {
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
          ...DEFAULTS,
          monthlyCapCredits: MONTHLY_CAP,
          updatedAt: row?.updatedAt.toISOString(),
        },
      });
      await expect(storedRow()).resolves.toEqual(row);
    });

    it('stores the defaults with the migrations alone, before the application ever runs', async () => {
      const fresh = await createSchema();
      try {
        await applyMigrations(fresh, migrationNames());
        const pg = await connectToSchema(fresh);
        try {
          const { rows } = await pg.query<Record<string, unknown>>(
            'SELECT "id", "startingRewardCredits", "dailyIncrementCredits", "maxDailyRewardCredits" FROM "DailyRewardSettings"',
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
      await ctx.client.dailyRewardSettings.deleteMany();

      await ctx.close();
      ctx = await bootApplication({ schema });

      await expect(ctx.client.dailyRewardSettings.count()).resolves.toBe(1);
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
          { maxDailyRewardCredits: 100 },
          { startingRewardCredits: 20 },
          { dailyIncrementCredits: 5 },
        ];
        for (const body of changes) {
          await patch(body, account()).expect(200);
        }

        expect(dataOf(await get(account()).expect(200))).toMatchObject({
          startingRewardCredits: 20,
          dailyIncrementCredits: 5,
          maxDailyRewardCredits: 100,
          monthlyCapCredits: MONTHLY_CAP,
        });
        await expect(storedRow()).resolves.toMatchObject({
          startingRewardCredits: 20,
          dailyIncrementCredits: 5,
          maxDailyRewardCredits: 100,
        });
        const events = await auditEvents();
        expect(events).toHaveLength(changes.length);
        expect(events.every((e) => e.actionedBy === account().id)).toBe(true);
      },
    );

    it('refuses requests without a token, with an invalid token, or with a non-Bearer scheme', async () => {
      const before = await snapshot();

      await get().expect(401);
      await patch({ startingRewardCredits: 20 }).expect(401);
      const garbage = { accessToken: 'not-a-jwt', id: 'none' };
      await get(garbage).expect(401);
      await patch({ startingRewardCredits: 20 }, garbage).expect(401);
      await http()
        .patch(ROUTE)
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Basic ${admin.accessToken}`)
        .send({ startingRewardCredits: 20 })
        .expect(401);

      await expect(snapshot()).resolves.toEqual(before);
    });

    it.each([
      ['USER', () => user],
      ['MODERATOR', () => moderator],
    ])(
      'a %s can neither read nor change any setting',
      async (_role, account) => {
        await patch({ dailyIncrementCredits: 15 }, admin).expect(200);
        const before = await snapshot();

        const read = await get(account()).expect(403);
        expect(read.body).toMatchObject({ success: false, statusCode: 403 });
        expect(JSON.stringify(read.body)).not.toContain('RewardCredits');
        for (const body of [
          { startingRewardCredits: 600 },
          { dailyIncrementCredits: 600 },
          { maxDailyRewardCredits: 600 },
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
      await patch({ maxDailyRewardCredits: 60 }, revoked).expect(401);

      await expect(snapshot()).resolves.toEqual(before);
    });
  });

  describe('validation', () => {
    const stored = {
      startingRewardCredits: 15,
      dailyIncrementCredits: 5,
      maxDailyRewardCredits: 40,
    };

    it.each([
      ['an empty body', {}],
      ['a negative starting reward', { startingRewardCredits: -10 }],
      ['a zero starting reward', { startingRewardCredits: 0 }],
      ['a fractional starting reward', { startingRewardCredits: 10.5 }],
      ['a negative increment', { dailyIncrementCredits: -10 }],
      ['a fractional increment', { dailyIncrementCredits: 2.5 }],
      ['a negative maximum', { maxDailyRewardCredits: -50 }],
      ['a zero maximum', { maxDailyRewardCredits: 0 }],
      ['a fractional maximum', { maxDailyRewardCredits: 39.5 }],
      [
        'a maximum above the 600-credit monthly cap',
        { maxDailyRewardCredits: 601 },
      ],
      ['an increment above 600', { dailyIncrementCredits: 601 }],
      ['a numeric string', { startingRewardCredits: '15' }],
      ['a boolean', { maxDailyRewardCredits: true }],
      ['null', { dailyIncrementCredits: null }],
      ['the read-only monthly cap', { monthlyCapCredits: 1200 }],
      ['an unknown field', { startingRewardCredits: 15, id: 2 }],
      [
        'a starting reward above the stored maximum',
        { startingRewardCredits: 41 },
      ],
      [
        'a maximum below the stored starting reward',
        { maxDailyRewardCredits: 14 },
      ],
      [
        'a starting reward above the maximum in the same request',
        { startingRewardCredits: 100, maxDailyRewardCredits: 90 },
      ],
      [
        'one invalid value next to valid ones',
        {
          startingRewardCredits: 20,
          dailyIncrementCredits: 20,
          maxDailyRewardCredits: -1,
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

    it('explains a starting reward above the maximum', async () => {
      const response = await patch({ startingRewardCredits: 60 }, admin).expect(
        400,
      );
      expect(response.body).toMatchObject({
        message:
          'startingRewardCredits (60) cannot exceed maxDailyRewardCredits (50)',
      });
    });

    it('has PostgreSQL reject invalid values written outside the API', async () => {
      await patch(stored, admin).expect(200);
      const before = await snapshot();

      for (const [data, constraint] of [
        [
          { startingRewardCredits: 0 },
          'DailyRewardSettings_startingRewardCredits_positive',
        ],
        [
          { dailyIncrementCredits: -1 },
          'DailyRewardSettings_dailyIncrementCredits_non_negative',
        ],
        [
          { maxDailyRewardCredits: 601 },
          'DailyRewardSettings_maxDailyRewardCredits_range',
        ],
        [
          { maxDailyRewardCredits: 14 },
          'DailyRewardSettings_maxDailyRewardCredits_range',
        ],
      ] as const) {
        await expect(
          ctx.client.dailyRewardSettings.update({ where: { id: 1 }, data }),
        ).rejects.toThrow(constraint);
      }
      await expect(
        ctx.client.dailyRewardSettings.create({ data: { id: 2 } }),
      ).rejects.toThrow('DailyRewardSettings_single_row');

      await expect(snapshot()).resolves.toEqual(before);
    });
  });

  describe('updates', () => {
    it('changes only the supplied fields and audits old and new values', async () => {
      const first = await patch({ maxDailyRewardCredits: 80 }, admin).expect(
        200,
      );
      expect(dataOf(first)).toEqual({
        startingRewardCredits: 10,
        dailyIncrementCredits: 10,
        maxDailyRewardCredits: 80,
        monthlyCapCredits: MONTHLY_CAP,
        updatedAt: expect.any(String) as unknown,
      });

      // Raising the starting reward above the old maximum is fine together
      // with a higher maximum.
      await patch(
        { startingRewardCredits: 60, dailyIncrementCredits: 0 },
        superadmin,
      ).expect(200);
      const unchanged = await patch(
        { maxDailyRewardCredits: 80 },
        admin,
      ).expect(200);

      const row = await storedRow();
      expect(row).toMatchObject({
        startingRewardCredits: 60,
        dailyIncrementCredits: 0,
        maxDailyRewardCredits: 80,
      });
      expect(dataOf(unchanged).updatedAt).toBe(row?.updatedAt.toISOString());
      await expect(auditEvents()).resolves.toEqual([
        {
          action: 'update',
          actionedBy: admin.id,
          recordId: '1',
          userAgent: 'daily-reward-settings-e2e',
          details: [
            {
              fieldName: 'maxDailyRewardCredits',
              oldValue: '50',
              newValue: '80',
            },
          ],
        },
        {
          action: 'update',
          actionedBy: superadmin.id,
          recordId: '1',
          userAgent: 'daily-reward-settings-e2e',
          details: [
            {
              fieldName: 'dailyIncrementCredits',
              oldValue: '10',
              newValue: '0',
            },
            {
              fieldName: 'startingRewardCredits',
              oldValue: '10',
              newValue: '60',
            },
          ],
        },
      ]);
    });

    it('accepts the boundary values', async () => {
      const minimums = {
        startingRewardCredits: 1,
        dailyIncrementCredits: 0,
        maxDailyRewardCredits: 1,
      };
      const maximums = {
        startingRewardCredits: MONTHLY_CAP,
        dailyIncrementCredits: MONTHLY_CAP,
        maxDailyRewardCredits: MONTHLY_CAP,
      };
      await patch(minimums, admin).expect(200);
      await expect(storedRow()).resolves.toMatchObject(minimums);
      await patch(maximums, superadmin).expect(200);
      await expect(storedRow()).resolves.toMatchObject(maximums);
    });

    it('validates concurrent changes against each other: never a stored invalid combination', async () => {
      // Each request is valid against the defaults (10 / 50) on its own, but
      // not together (40 > 30). The row lock makes the second request see
      // the first one's result, so it is rejected with 400 (not a 500 from
      // the CHECK constraint) and nothing invalid is stored.
      for (let round = 0; round < 5; round += 1) {
        await ctx.client.dailyRewardSettings.deleteMany();
        await ctx
          .get<DailyRewardSettingsService>(DailyRewardSettingsService)
          .ensureDefaults();
        await ctx.client.activityLogEvent.deleteMany({
          where: { tableName: 'DailyRewardSettings' },
        });

        const [raise, lower] = await Promise.all([
          patch({ startingRewardCredits: 40 }, admin),
          patch({ maxDailyRewardCredits: 30 }, superadmin),
        ]);

        expect([raise.status, lower.status].sort()).toEqual([200, 400]);
        const row = await storedRow();
        expect(row?.startingRewardCredits).toBeLessThanOrEqual(
          row?.maxDailyRewardCredits ?? 0,
        );
        expect(row).toMatchObject(
          raise.status === 200
            ? { startingRewardCredits: 40, maxDailyRewardCredits: 50 }
            : { startingRewardCredits: 10, maxDailyRewardCredits: 30 },
        );
        await expect(auditEvents()).resolves.toHaveLength(1);
      }
    });
  });

  describe('persistence', () => {
    it('keeps the saved configuration across an application restart', async () => {
      const saved = {
        startingRewardCredits: 5,
        dailyIncrementCredits: 15,
        maxDailyRewardCredits: 75,
      };
      await patch(saved, admin).expect(200);
      const rowBefore = await storedRow();

      await ctx.close();
      ctx = await bootApplication({ schema });

      await expect(storedRow()).resolves.toEqual(rowBefore);
      await expect(ctx.client.dailyRewardSettings.count()).resolves.toBe(1);
      expect(dataOf(await get(superadmin).expect(200))).toEqual({
        ...saved,
        monthlyCapCredits: MONTHLY_CAP,
        updatedAt: rowBefore?.updatedAt.toISOString(),
      });

      // Later partial changes are validated against the persisted values.
      await patch({ startingRewardCredits: 76 }, admin).expect(400);
      await patch({ startingRewardCredits: 75 }, admin).expect(200);
      await ctx.close();
      ctx = await bootApplication({ schema });
      expect(dataOf(await get(admin).expect(200))).toMatchObject({
        ...saved,
        startingRewardCredits: 75,
      });
    });
  });
});
