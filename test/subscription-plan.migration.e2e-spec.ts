import {
  applyMigrations,
  connectToSchema,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';

/**
 * Verifies that 20260912120000_plan_billing_intervals_and_toggles carries
 * configurations saved under the previous single-price schema forward.
 */
const TARGET = '20260912120000_plan_billing_intervals_and_toggles';

jest.setTimeout(60_000);

describeWithDatabase(
  'SubscriptionPlan migration to monthly/yearly pricing',
  () => {
    const schemas: string[] = [];

    afterAll(async () => {
      await Promise.all(schemas.map((schema) => dropSchema(schema)));
    });

    /** Builds a schema at the previous version, seeds it, then migrates. */
    async function migrateFrom(seedSql: string | null) {
      const all = migrationNames();
      const targetIndex = all.indexOf(TARGET);
      expect(targetIndex).toBeGreaterThan(0);

      const schema = await createSchema();
      schemas.push(schema);
      await applyMigrations(schema, all.slice(0, targetIndex));

      const client = await connectToSchema(schema);
      try {
        if (seedSql) await client.query(seedSql);
        await applyMigrations(schema, all.slice(targetIndex));
        const { rows } = await client.query('SELECT * FROM "SubscriptionPlan"');
        return { schema, rows };
      } finally {
        await client.end();
      }
    }

    it('keeps a configured price as the monthly price and a non-zero trial as an enabled trial', async () => {
      const { rows } = await migrateFrom(`
      INSERT INTO "SubscriptionPlan" ("code", "priceUsdCents", "trialDays", "createdAt", "updatedAt")
      VALUES ('PRO', 999, 14, '2026-09-10T10:00:00Z', '2026-09-11T10:00:00Z');
    `);

      expect(rows).toEqual([
        {
          code: 'PRO',
          planEnabled: true,
          monthlyPriceUsdCents: 999,
          yearlyPriceUsdCents: 19000,
          trialEnabled: true,
          trialDays: 14,
          createdAt: new Date('2026-09-10T10:00:00Z'),
          updatedAt: new Date('2026-09-11T10:00:00Z'),
        },
      ]);
    });

    it('gives a never-priced plan the $19 default and turns a 0-day trial into a disabled 7-day trial', async () => {
      const { rows } = await migrateFrom(`
      INSERT INTO "SubscriptionPlan" ("code", "priceUsdCents", "trialDays", "updatedAt")
      VALUES ('PRO', NULL, 0, CURRENT_TIMESTAMP);
    `);

      expect(rows).toEqual([
        expect.objectContaining({
          planEnabled: true,
          monthlyPriceUsdCents: 1900,
          yearlyPriceUsdCents: 19000,
          trialEnabled: false,
          trialDays: 7,
        }),
      ]);
    });

    it('leaves an unconfigured database empty and applies the new defaults to later inserts', async () => {
      const { schema, rows } = await migrateFrom(null);
      expect(rows).toEqual([]);

      const client = await connectToSchema(schema);
      try {
        const { rows: inserted } = await client.query(`
        INSERT INTO "SubscriptionPlan" ("code", "updatedAt")
        VALUES ('PRO', CURRENT_TIMESTAMP) RETURNING *
      `);
        expect(inserted[0]).toMatchObject({
          planEnabled: true,
          monthlyPriceUsdCents: 1900,
          yearlyPriceUsdCents: 19000,
          trialEnabled: true,
          trialDays: 7,
        });
      } finally {
        await client.end();
      }
    });

    it('preserves existing audit history', async () => {
      const { schema } = await migrateFrom(`
      INSERT INTO "ActivityLogEvent" ("id", "tableName", "recordId", "action")
      VALUES ('audit-1', 'SubscriptionPlan', 'PRO', 'update');
      INSERT INTO "ActivityLogEventDetail" ("id", "eventId", "fieldName", "oldValue", "newValue")
      VALUES ('detail-1', 'audit-1', 'priceUsdCents', NULL, '999');
    `);

      const client = await connectToSchema(schema);
      try {
        const { rows } = await client.query(
          'SELECT "fieldName", "newValue" FROM "ActivityLogEventDetail"',
        );
        expect(rows).toEqual([{ fieldName: 'priceUsdCents', newValue: '999' }]);
      } finally {
        await client.end();
      }
    });

    it('enforces the new invariants at the database level', async () => {
      const { schema } = await migrateFrom(`
      INSERT INTO "SubscriptionPlan" ("code", "priceUsdCents", "trialDays", "updatedAt")
      VALUES ('PRO', 999, 7, CURRENT_TIMESTAMP);
    `);

      const client = await connectToSchema(schema);
      try {
        for (const assignment of [
          '"trialDays" = 0',
          '"monthlyPriceUsdCents" = 0',
          '"yearlyPriceUsdCents" = -1',
          '"monthlyPriceUsdCents" = NULL',
          '"planEnabled" = NULL',
        ]) {
          await expect(
            client.query(`UPDATE "SubscriptionPlan" SET ${assignment}`),
          ).rejects.toThrow(/violates (check|not-null) constraint/);
        }
        await expect(
          client.query('SELECT "priceUsdCents" FROM "SubscriptionPlan"'),
        ).rejects.toThrow(/does not exist/);
      } finally {
        await client.end();
      }
    });
  },
);
