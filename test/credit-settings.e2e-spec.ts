// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { userRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { CreditSettingsService } from '../src/credits/credit-settings.service';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import { MakeupCreditService } from '../src/makeup/makeup-credit.service';
import {
  expectConsistentLedger,
  givenCreditsInPostgres,
} from './support/credit-fixtures';
import {
  applyMigrations,
  connectToSchema,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import {
  bootApplication,
  type TestApplication,
} from './support/infrastructure-flows';

jest.setTimeout(120_000);

const ROUTE = '/v1/admin/credit-settings';
/** The product defaults, as stored by the migrations and at startup. */
const DEFAULTS = {
  trialCredits: 50,
  proMonthlyCredits: 1000,
  creditCostUsdMicros: 5000,
  sessionOverageCredits: 5,
  deductionStepMicroCredits: 1,
};
const PASSWORD = 'credit settings e2e password';

interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
}
interface CreditSettingsData {
  trialCredits: number;
  proMonthlyCredits: number;
  creditCostUsdMicros: number;
  creditCostUsd: string;
  sessionOverageCredits: number;
  deductionStepMicroCredits: number;
  deductionStepCredits: string;
  updatedAt: string | null;
}
const dataOf = (response: { body: unknown }) =>
  (response.body as Envelope<CreditSettingsData>).data;

interface Account {
  id: string;
  accessToken: string;
}

/**
 * AI credit configuration through the complete application (AppModule, HTTP,
 * real guards and validation) against a migrated PostgreSQL schema. Tokens
 * come from the real login endpoint; no external service is contacted
 * (REDIS_ENABLED=false, AI_MODE=mock, local storage, captured emails, no
 * Stripe key). A restart is simulated by closing the application and booting
 * a new one, with new database connections, on the same schema.
 */
describeWithDatabase('AI credit settings (PostgreSQL, full stack)', () => {
  let schema: string;
  let ctx: TestApplication;
  let admin: Account;
  let superadmin: Account;
  let user: Account;
  let moderator: Account;
  /** The stored configuration right after the first boot, before any request. */
  let initialRow: unknown;
  let initialRowCount: number;
  let initialAuditCount: number;
  let ipCounter = 0;
  /** A client address per test, so the per-IP rate limits never interfere. */
  let ip: string;
  const nextIp = () => `203.0.113.${(ipCounter += 1)}`;

  const http = () => request(ctx.app.getHttpServer());
  const bearer = (account: Account) => `Bearer ${account.accessToken}`;
  const get = (account?: Account) => {
    const req = http().get(ROUTE).set('X-Forwarded-For', ip);
    return account ? req.set('Authorization', bearer(account)) : req;
  };
  const patch = (body: unknown, account?: Account) => {
    const req = http()
      .patch(ROUTE)
      .set('X-Forwarded-For', ip)
      .set('User-Agent', 'credit-settings-e2e');
    return (account ? req.set('Authorization', bearer(account)) : req).send(
      body as object,
    );
  };

  /** The stored settings row (null only if someone deleted it). */
  const storedRow = () =>
    ctx.client.creditSettings.findUnique({ where: { id: 1 } });
  const auditEvents = () =>
    ctx.client.activityLogEvent.findMany({
      where: { tableName: 'CreditSettings' },
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
    rows: await ctx.client.creditSettings.count(),
    audit: await ctx.client.activityLogEvent.count({
      where: { tableName: 'CreditSettings' },
    }),
  });

  /** An active, verified local account, signed in over HTTP. */
  const signIn = async (role: userRole): Promise<Account> => {
    const tag = randomBytes(5).toString('hex');
    const email = `${role.toLowerCase()}_${tag}@example.com`;
    const created = await ctx.client.authUser.create({
      data: {
        email,
        username: `${role.toLowerCase()}_${tag}`,
        password: await bcrypt.hash(PASSWORD, 4),
        verified: true,
        role,
      },
    });
    const response = await http()
      .post('/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({ email, password: PASSWORD })
      .expect(201);
    const login = (
      response.body as Envelope<{ accessToken: string; user: { role: string } }>
    ).data;
    expect(login.user.role).toBe(role);
    return { id: created.id, accessToken: login.accessToken };
  };

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    ctx = await bootApplication({ schema });
    initialRow = await storedRow();
    initialRowCount = await ctx.client.creditSettings.count();
    initialAuditCount = await ctx.client.activityLogEvent.count({
      where: { tableName: 'CreditSettings' },
    });
    admin = await signIn(userRole.ADMIN);
    superadmin = await signIn(userRole.SUPERADMIN);
    user = await signIn(userRole.USER);
    moderator = await signIn(userRole.MODERATOR);
  });

  afterAll(async () => {
    await ctx?.close();
    if (schema) await dropSchema(schema);
  });

  /** Back to the stored defaults, through the production startup path. */
  beforeEach(async () => {
    ip = nextIp();
    await ctx.client.creditSettings.deleteMany();
    await ctx
      .get<CreditSettingsService>(CreditSettingsService)
      .ensureDefaults();
    await ctx.client.activityLogEvent.deleteMany({
      where: { tableName: 'CreditSettings' },
    });
  });

  describe('default values stored in PostgreSQL', () => {
    it('has the defaults stored in PostgreSQL before any administrator change', async () => {
      // Captured right after the first boot, before any request was made.
      expect(initialRowCount).toBe(1);
      expect(initialAuditCount).toBe(0);
      expect(initialRow).toEqual({
        id: 1,
        ...DEFAULTS,
        createdAt: expect.any(Date) as unknown,
        updatedAt: expect.any(Date) as unknown,
      });

      // The API serves exactly the stored row.
      const row = await storedRow();
      const response = await get(admin).expect(200);
      expect(response.body).toEqual({
        statusCode: 200,
        message: 'Success',
        data: {
          trialCredits: 50,
          proMonthlyCredits: 1000,
          creditCostUsdMicros: 5000,
          creditCostUsd: '0.005',
          sessionOverageCredits: 5,
          deductionStepMicroCredits: 1,
          deductionStepCredits: '0.000001',
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
            'SELECT "id", "trialCredits", "proMonthlyCredits", "creditCostUsdMicros", "sessionOverageCredits", "deductionStepMicroCredits" FROM "CreditSettings"',
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
      await ctx.client.creditSettings.deleteMany();

      await ctx.close();
      ctx = await bootApplication({ schema });

      await expect(ctx.client.creditSettings.count()).resolves.toBe(1);
      await expect(storedRow()).resolves.toMatchObject({ id: 1, ...DEFAULTS });
    });

    it('changing one setting keeps the other stored defaults', async () => {
      await patch({ sessionOverageCredits: 8 }, admin).expect(200);

      await expect(storedRow()).resolves.toMatchObject({
        id: 1,
        ...DEFAULTS,
        sessionOverageCredits: 8,
      });
      await expect(ctx.client.creditSettings.count()).resolves.toBe(1);
    });
  });

  describe('administrator access', () => {
    it.each([
      ['ADMIN', () => admin],
      ['SUPERADMIN', () => superadmin],
    ])(
      '%s can read and change every setting; each change is stored and attributed',
      async (_role, account) => {
        const changes = [
          { trialCredits: 40 },
          { proMonthlyCredits: 1200 },
          { creditCostUsdMicros: 4000 },
          { sessionOverageCredits: 3 },
          { deductionStepMicroCredits: 100_000 },
        ];
        for (const body of changes) {
          await patch(body, account()).expect(200);
        }

        expect(dataOf(await get(account()).expect(200))).toMatchObject({
          trialCredits: 40,
          proMonthlyCredits: 1200,
          creditCostUsdMicros: 4000,
          creditCostUsd: '0.004',
          sessionOverageCredits: 3,
          deductionStepMicroCredits: 100_000,
          deductionStepCredits: '0.1',
        });
        await expect(storedRow()).resolves.toMatchObject({
          trialCredits: 40,
          proMonthlyCredits: 1200,
          creditCostUsdMicros: 4000,
          sessionOverageCredits: 3,
          deductionStepMicroCredits: 100_000,
        });
        const events = await auditEvents();
        expect(events).toHaveLength(changes.length);
        expect(events.every((e) => e.actionedBy === account().id)).toBe(true);
      },
    );
  });

  describe('rejected unauthorized requests', () => {
    it('refuses requests without a token, with an invalid token, or with a non-Bearer scheme', async () => {
      const before = await snapshot();

      await get().expect(401);
      await patch({ trialCredits: 1 }).expect(401);
      const garbage = { accessToken: 'not-a-jwt', id: 'none' };
      await get(garbage).expect(401);
      await patch({ trialCredits: 1 }, garbage).expect(401);
      await http()
        .patch(ROUTE)
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Basic ${admin.accessToken}`)
        .send({ trialCredits: 1 })
        .expect(401);

      await expect(snapshot()).resolves.toEqual(before);
    });

    it.each([
      ['USER', () => user],
      ['MODERATOR', () => moderator],
    ])(
      'a %s can neither read nor change any setting',
      async (_role, account) => {
        await patch({ trialCredits: 70 }, admin).expect(200);
        const before = await snapshot();

        const read = await get(account()).expect(403);
        expect(read.body).toMatchObject({ success: false, statusCode: 403 });
        expect(JSON.stringify(read.body)).not.toContain('trialCredits');
        for (const body of [
          { trialCredits: 100_000 },
          { proMonthlyCredits: 1_000_000 },
          { creditCostUsdMicros: 1 },
          { sessionOverageCredits: 1000 },
          { deductionStepMicroCredits: 1 },
        ]) {
          await patch(body, account()).expect(403);
        }

        await expect(snapshot()).resolves.toEqual(before);
      },
    );

    it('refuses an administrator token once it has been revoked', async () => {
      const revoked = await signIn(userRole.ADMIN);
      await get(revoked).expect(200);
      // A security event (e.g. logout-all) increments the token version.
      await ctx.client.authUser.update({
        where: { id: revoked.id },
        data: { tokenVersion: { increment: 1 } },
      });
      const before = await snapshot();

      await get(revoked).expect(401);
      await patch({ trialCredits: 10 }, revoked).expect(401);

      await expect(snapshot()).resolves.toEqual(before);
    });
  });

  describe('rejected invalid requests', () => {
    const stored = {
      trialCredits: 60,
      proMonthlyCredits: 1500,
      creditCostUsdMicros: 2500,
      sessionOverageCredits: 4,
    };

    it.each([
      ['an empty body', {}],
      ['negative trial credits', { trialCredits: -50 }],
      ['zero trial credits', { trialCredits: 0 }],
      ['negative Pro credits', { proMonthlyCredits: -1 }],
      ['zero Pro credits', { proMonthlyCredits: 0 }],
      ['a negative credit cost', { creditCostUsdMicros: -5000 }],
      ['a zero credit cost', { creditCostUsdMicros: 0 }],
      ['the credit cost given in dollars', { creditCostUsdMicros: 0.005 }],
      ['negative overage credits', { sessionOverageCredits: -5 }],
      ['trial credits above the maximum', { trialCredits: 100_001 }],
      ['Pro credits above the maximum', { proMonthlyCredits: 1_000_001 }],
      ['a credit cost above $1', { creditCostUsdMicros: 1_000_001 }],
      ['overage above the maximum', { sessionOverageCredits: 1_001 }],
      ['a zero deduction step', { deductionStepMicroCredits: 0 }],
      ['a negative deduction step', { deductionStepMicroCredits: -1 }],
      [
        'a deduction step above one credit',
        { deductionStepMicroCredits: 1_000_001 },
      ],
      [
        'the deduction step given in credits',
        { deductionStepMicroCredits: 0.5 },
      ],
      ['the read-only deductionStepCredits', { deductionStepCredits: '0.1' }],
      ['fractional credits', { proMonthlyCredits: 999.5 }],
      ['a fractional credit cost', { creditCostUsdMicros: 4999.5 }],
      ['a numeric string', { trialCredits: '50' }],
      ['null', { sessionOverageCredits: null }],
      ['a boolean', { trialCredits: true }],
      ['the read-only creditCostUsd', { creditCostUsd: '0.001' }],
      ['an unknown field', { trialCredits: 55, id: 2 }],
      [
        'one invalid value next to valid ones',
        { trialCredits: 55, proMonthlyCredits: 2000, creditCostUsdMicros: -1 },
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

    it('has PostgreSQL reject negative or zero values written outside the API', async () => {
      await patch(stored, admin).expect(200);
      const before = await snapshot();

      for (const [column, value, constraint] of [
        ['trialCredits', -1, 'CreditSettings_trialCredits_positive'],
        ['proMonthlyCredits', 0, 'CreditSettings_proMonthlyCredits_positive'],
        [
          'creditCostUsdMicros',
          0,
          'CreditSettings_creditCostUsdMicros_positive',
        ],
        [
          'sessionOverageCredits',
          -1,
          'CreditSettings_sessionOverageCredits_non_negative',
        ],
        [
          'deductionStepMicroCredits',
          0,
          'CreditSettings_deductionStepMicroCredits_positive',
        ],
      ] as const) {
        await expect(
          ctx.client.creditSettings.update({
            where: { id: 1 },
            data: { [column]: value },
          }),
        ).rejects.toThrow(constraint);
      }
      // There is only ever one configuration row.
      await expect(
        ctx.client.creditSettings.create({ data: { id: 2 } }),
      ).rejects.toThrow('CreditSettings_single_row');

      await expect(snapshot()).resolves.toEqual(before);
    });
  });

  describe('successful updates', () => {
    it('changes only the supplied fields and audits old and new values', async () => {
      const first = await patch({ trialCredits: 75 }, admin).expect(200);
      expect(dataOf(first)).toEqual({
        trialCredits: 75,
        proMonthlyCredits: 1000,
        creditCostUsdMicros: 5000,
        creditCostUsd: '0.005',
        sessionOverageCredits: 5,
        deductionStepMicroCredits: 1,
        deductionStepCredits: '0.000001',
        updatedAt: expect.any(String) as unknown,
      });

      const second = await patch(
        { creditCostUsdMicros: 6000, sessionOverageCredits: 0 },
        admin,
      ).expect(200);
      expect(dataOf(second)).toMatchObject({
        trialCredits: 75,
        proMonthlyCredits: 1000,
        creditCostUsdMicros: 6000,
        creditCostUsd: '0.006',
        sessionOverageCredits: 0,
      });

      // Saving unchanged values succeeds without a new audit entry.
      const unchanged = await patch({ trialCredits: 75 }, admin).expect(200);

      const row = await storedRow();
      expect(row).toMatchObject({
        trialCredits: 75,
        proMonthlyCredits: 1000,
        creditCostUsdMicros: 6000,
        sessionOverageCredits: 0,
      });
      // The response reflects the stored row.
      expect(dataOf(unchanged).updatedAt).toBe(row?.updatedAt.toISOString());
      await expect(auditEvents()).resolves.toEqual([
        {
          action: 'update',
          actionedBy: admin.id,
          recordId: '1',
          userAgent: 'credit-settings-e2e',
          details: [
            { fieldName: 'trialCredits', oldValue: '50', newValue: '75' },
          ],
        },
        {
          action: 'update',
          actionedBy: admin.id,
          recordId: '1',
          userAgent: 'credit-settings-e2e',
          details: [
            {
              fieldName: 'creditCostUsdMicros',
              oldValue: '5000',
              newValue: '6000',
            },
            {
              fieldName: 'sessionOverageCredits',
              oldValue: '5',
              newValue: '0',
            },
          ],
        },
      ]);
    });

    it('accepts the boundary values', async () => {
      const minimums = {
        trialCredits: 1,
        proMonthlyCredits: 1,
        creditCostUsdMicros: 1,
        sessionOverageCredits: 0,
        deductionStepMicroCredits: 1,
      };
      const maximums = {
        trialCredits: 100_000,
        proMonthlyCredits: 1_000_000,
        creditCostUsdMicros: 1_000_000,
        sessionOverageCredits: 1_000,
        deductionStepMicroCredits: 1_000_000,
      };
      const lowest = await patch(minimums, admin).expect(200);
      expect(dataOf(lowest)).toMatchObject({
        creditCostUsd: '0.000001',
        deductionStepCredits: '0.000001',
      });
      await expect(storedRow()).resolves.toMatchObject(minimums);
      const response = await patch(maximums, superadmin).expect(200);
      expect(dataOf(response)).toMatchObject({
        creditCostUsd: '1',
        deductionStepCredits: '1',
      });
      await expect(storedRow()).resolves.toMatchObject(maximums);
    });

    it('applies concurrent changes one at a time, with an exact audit chain', async () => {
      const values = [900, 1100, 1300, 1500, 1700];
      const responses = await Promise.all(
        values.map((credits) => patch({ proMonthlyCredits: credits }, admin)),
      );
      expect(responses.map((response) => response.status)).toEqual(
        Array(values.length).fill(200),
      );
      await expect(ctx.client.creditSettings.count()).resolves.toBe(1);

      // Each audit entry's old value is the previous entry's new value:
      // the changes form one chain from the default to the stored value.
      const changes = (await auditEvents()).map((event) => event.details[0]);
      expect(changes).toHaveLength(values.length);
      let current = '1000';
      for (let step = 0; step < values.length; step += 1) {
        const next = changes.find((change) => change?.oldValue === current);
        expect(next).toBeDefined();
        current = next?.newValue as string;
      }
      const row = await storedRow();
      expect(String(row?.proMonthlyCredits)).toBe(current);
    });
  });

  describe('changing the OpenRouter credit cost conversion', () => {
    /** A USER with purchased credits and a makeup session created over HTTP. */
    const customerWithSession = async (credits: string) => {
      const account = await signIn(userRole.USER);
      await givenCreditsInPostgres(ctx.client, account.id, 'PURCHASE', credits);
      const created = await http()
        .post('/v1/sessions')
        .set('X-Forwarded-For', ip)
        .set('Authorization', bearer(account))
        .expect(201);
      const session = (created.body as Envelope<{ id: string }>).data;
      return { account, sessionId: session.id };
    };

    /**
     * One OpenRouter request of an AI run, recorded and charged the way the
     * makeup job handler does when it publishes the run's result (AI_MODE is
     * mock here, so the provider usage is given directly; no external call).
     */
    const chargeOpenRouterRequest = async (
      account: Account,
      sessionId: string,
      costUsd: string,
    ) => {
      const credits = ctx.get<MakeupCreditService>(MakeupCreditService);
      const runId = randomUUID();
      const usage = await credits.recordUsage(
        { runId, authId: account.id, sessionId },
        'GUIDE_GENERATION',
        'openrouter',
        {
          responseId: `gen-${runId}`,
          model: 'openai/gpt-4o-mini',
          usage: {
            promptTokens: 1200,
            completionTokens: 300,
            totalTokens: 1500,
            costUsd,
          },
        },
      );
      if (!usage) throw new Error('the usage was not recorded');
      const sources = await credits.usableSources(account.id);
      const charge = await ctx.client.$transaction((tx) =>
        credits.chargeRun(tx, usage, sources),
      );
      return { usageId: usage.id, runId, charge };
    };

    /** The stored charge terms of a usage and of its DEBIT transaction. */
    const chargeHistory = async (usageId: string) => {
      const usage = await ctx.client.aiUsage.findUniqueOrThrow({
        where: { id: usageId },
        include: { transaction: true },
      });
      return {
        costUsd: usage.costUsd?.toFixed(),
        creditCostUsdMicros: usage.creditCostUsdMicros,
        creditsExact: usage.creditsExact?.toFixed(),
        creditsDue: usage.creditsDue?.toFixed(),
        creditsCharged: usage.creditsCharged?.toFixed(),
        chargeStatus: usage.chargeStatus,
        debit: usage.transaction && {
          type: usage.transaction.type,
          amount: usage.transaction.amount.toFixed(),
          usageCostUsd: usage.transaction.usageCostUsd?.toFixed(),
          creditCostUsdMicros: usage.transaction.creditCostUsdMicros,
          idempotencyKey: usage.transaction.idempotencyKey,
        },
      };
    };

    it('charges new AI usage at the new rate and keeps earlier deductions at the rate they were charged at', async () => {
      const { account, sessionId } = await customerWithSession('100');
      const balance = () =>
        ctx
          .get<CreditWalletService>(CreditWalletService)
          .getBalance(account.id);

      // At the default $0.005 per credit: $0.025 = 5 credits.
      const before = await chargeOpenRouterRequest(account, sessionId, '0.025');
      expect(before.charge).toMatchObject({
        status: 'CHARGED',
        creditsDue: '5',
        creditsCharged: '5',
      });
      const beforeHistory = await chargeHistory(before.usageId);
      expect(beforeHistory).toEqual({
        costUsd: '0.025',
        creditCostUsdMicros: 5000,
        creditsExact: '5',
        creditsDue: '5',
        creditsCharged: '5',
        chargeStatus: 'CHARGED',
        debit: {
          type: 'DEBIT',
          amount: '-5',
          usageCostUsd: '0.025',
          creditCostUsdMicros: 5000,
          idempotencyKey: `debit:ai-run:${before.runId}`,
        },
      });
      await expect(balance()).resolves.toMatchObject({ available: '95' });

      // An administrator lowers the price of a credit to $0.002.
      const changed = await patch({ creditCostUsdMicros: 2000 }, admin).expect(
        200,
      );
      expect(dataOf(changed)).toMatchObject({
        creditCostUsdMicros: 2000,
        creditCostUsd: '0.002',
      });
      await expect(auditEvents()).resolves.toEqual([
        expect.objectContaining({
          actionedBy: admin.id,
          details: [
            {
              fieldName: 'creditCostUsdMicros',
              oldValue: '5000',
              newValue: '2000',
            },
          ],
        }),
      ]);

      // The same cost now buys fewer requests: $0.025 = 12.5 credits.
      const after = await chargeOpenRouterRequest(account, sessionId, '0.025');
      expect(after.charge).toMatchObject({
        status: 'CHARGED',
        creditsDue: '12.5',
        creditsCharged: '12.5',
      });
      await expect(chargeHistory(after.usageId)).resolves.toEqual({
        costUsd: '0.025',
        creditCostUsdMicros: 2000,
        creditsExact: '12.5',
        creditsDue: '12.5',
        creditsCharged: '12.5',
        chargeStatus: 'CHARGED',
        debit: {
          type: 'DEBIT',
          amount: '-12.5',
          usageCostUsd: '0.025',
          creditCostUsdMicros: 2000,
          idempotencyKey: `debit:ai-run:${after.runId}`,
        },
      });
      // The earlier deduction is unchanged, row for row.
      await expect(chargeHistory(before.usageId)).resolves.toEqual(
        beforeHistory,
      );
      await expect(balance()).resolves.toMatchObject({ available: '82.5' });

      // Charging the earlier run again (a retry) deducts nothing at any rate.
      const earlier = await ctx.client.aiUsage.findUniqueOrThrow({
        where: { id: before.usageId },
      });
      await expect(
        ctx.client.$transaction((tx) =>
          ctx
            .get<MakeupCreditService>(MakeupCreditService)
            .chargeRun(tx, earlier, ['PURCHASE']),
        ),
      ).resolves.toMatchObject({ status: 'CHARGED', creditsCharged: '5' });
      await expect(chargeHistory(before.usageId)).resolves.toEqual(
        beforeHistory,
      );
      await expect(balance()).resolves.toMatchObject({ available: '82.5' });

      // The user sees both requests with the credits each one cost.
      const summary = await http()
        .get(`/v1/sessions/${sessionId}/ai-usage`)
        .set('X-Forwarded-For', ip)
        .set('Authorization', bearer(account))
        .expect(200);
      const usage = (
        summary.body as Envelope<{
          usages: Array<{ costUsd: string; creditsCharged: string }>;
          totals: Record<string, unknown>;
        }>
      ).data;
      expect(usage.usages.map((u) => [u.costUsd, u.creditsCharged])).toEqual([
        ['0.025', '5'],
        ['0.025', '12.5'],
      ]);
      expect(usage.totals).toMatchObject({
        requests: 2,
        costUsd: '0.05',
        creditsCharged: '17.5',
      });
      await expectConsistentLedger(ctx.client, account.id);
    });
    it('applies a changed rate together with a fractional deduction step', async () => {
      const { account, sessionId } = await customerWithSession('10');

      // $0.01 per credit, deducted in tenths of a credit.
      await patch(
        { creditCostUsdMicros: 10_000, deductionStepMicroCredits: 100_000 },
        superadmin,
      ).expect(200);

      // $0.023 = 2.3 credits exactly; $0.00231 = 0.231 -> 0.3.
      const exact = await chargeOpenRouterRequest(account, sessionId, '0.023');
      const rounded = await chargeOpenRouterRequest(
        account,
        sessionId,
        '0.00231',
      );
      expect([
        exact.charge.creditsCharged,
        rounded.charge.creditsCharged,
      ]).toEqual(['2.3', '0.3']);
      await expect(chargeHistory(rounded.usageId)).resolves.toMatchObject({
        costUsd: '0.00231',
        creditCostUsdMicros: 10_000,
        creditsExact: '0.231',
        creditsDue: '0.3',
        debit: { amount: '-0.3', creditCostUsdMicros: 10_000 },
      });
      await expect(
        ctx
          .get<CreditWalletService>(CreditWalletService)
          .getBalance(account.id),
      ).resolves.toMatchObject({ available: '7.4' });
      await expectConsistentLedger(ctx.client, account.id);
    });
  });

  describe('persistence', () => {
    it('keeps the saved configuration across an application restart', async () => {
      const saved = {
        trialCredits: 30,
        proMonthlyCredits: 2500,
        creditCostUsdMicros: 7500,
        sessionOverageCredits: 2,
        deductionStepMicroCredits: 500_000,
      };
      await patch(saved, admin).expect(200);
      const rowBefore = await storedRow();

      // Restart: a new application with new connections on the same database.
      // Startup stores defaults only when no row exists, so it must not
      // touch the administrator's values (not even updatedAt).
      await ctx.close();
      ctx = await bootApplication({ schema });

      await expect(storedRow()).resolves.toEqual(rowBefore);
      await expect(ctx.client.creditSettings.count()).resolves.toBe(1);
      expect(dataOf(await get(admin).expect(200))).toEqual({
        ...saved,
        creditCostUsd: '0.0075',
        deductionStepCredits: '0.5',
        updatedAt: rowBefore?.updatedAt.toISOString(),
      });

      // Further partial changes build on the persisted values.
      await patch({ sessionOverageCredits: 6 }, superadmin).expect(200);
      await ctx.close();
      ctx = await bootApplication({ schema });

      expect(dataOf(await get(superadmin).expect(200))).toMatchObject({
        ...saved,
        sessionOverageCredits: 6,
      });
      await expect(ctx.client.creditSettings.count()).resolves.toBe(1);
    });
  });
});
