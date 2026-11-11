import { PrismaPg } from '@prisma/adapter-pg';
import { BillingInterval, PrismaClient, userStatus } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { SubscriptionAccessService } from '../src/subscription/subscription-access.service';
import { SubscriptionPlanService } from '../src/subscription/subscription-plan.service';
import { SubscriptionTrialService } from '../src/subscription/subscription-trial.service';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import {
  createUser,
  daysFrom,
  givenFreeRecord,
  givenPaidProHistory,
} from './support/subscription-fixtures';

jest.setTimeout(60_000);

describeWithDatabase('Free trial activation (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  let prisma: PrismaService;
  let plans: SubscriptionPlanService;
  let trials: SubscriptionTrialService;
  let access: SubscriptionAccessService;
  let adminId: string;

  const now = new Date('2026-03-01T09:30:00.000Z');
  const meta = { ip: '127.0.0.1', userAgent: 'trial-e2e' };
  const recordOf = (authId: string) =>
    client.userSubscription.findUnique({ where: { authId } });

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    client = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: TEST_DATABASE_URL as string },
        { schema },
      ),
    });
    prisma = client as unknown as PrismaService;
    const activityLog = new ActivityLogService(
      prisma,
      mock<CustomLoggerService>(),
    );
    plans = new SubscriptionPlanService(prisma, activityLog);
    trials = new SubscriptionTrialService(prisma, plans, activityLog);
    access = new SubscriptionAccessService(prisma, plans);
    adminId = await createUser(client);
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
  });

  beforeEach(async () => {
    // Every test starts from the default plan (enabled, 7-day trial).
    await client.subscriptionPlan.deleteMany();
  });

  describe('successful activation', () => {
    it('stores the start date and start + 7 days as the expiry, and grants access', async () => {
      const userId = await createUser(client);

      await expect(trials.activateTrial(userId, meta, now)).resolves.toEqual({
        status: 'TRIAL',
        hasProAccess: true,
        accessSource: 'TRIAL',
        accessExpiresAt: '2026-03-08T09:30:00.000Z',
        trialStartedAt: '2026-03-01T09:30:00.000Z',
        trialExpiresAt: '2026-03-08T09:30:00.000Z',
      });

      await expect(recordOf(userId)).resolves.toMatchObject({
        status: 'TRIAL',
        trialUsed: true,
        trialStartedAt: now,
        trialExpiresAt: daysFrom(now, 7),
        proStartedAt: null,
      });
      await expect(access.hasProAccess(userId, daysFrom(now, 6))).resolves.toBe(
        true,
      );
      await expect(access.hasProAccess(userId, daysFrom(now, 7))).resolves.toBe(
        false,
      );
    });

    it('uses the trial length configured by an administrator', async () => {
      await plans.updateProPlan({ trialDays: 14 }, { actionedBy: adminId });
      const userId = await createUser(client);

      await trials.activateTrial(userId, meta, now);

      await expect(recordOf(userId)).resolves.toMatchObject({
        trialExpiresAt: daysFrom(now, 14),
      });
    });

    it('activates on an existing unused record and writes an audit event', async () => {
      const userId = await createUser(client);
      const existing = await givenFreeRecord(client, userId);

      await trials.activateTrial(userId, meta, now);

      await expect(recordOf(userId)).resolves.toMatchObject({
        id: existing.id,
        status: 'TRIAL',
      });
      const events = await client.activityLogEvent.findMany({
        where: { tableName: 'UserSubscription', recordId: existing.id },
        include: { details: true },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'update',
        actionedBy: userId,
        userAgent: 'trial-e2e',
      });
      expect(events[0].details.map((d) => d.fieldName).sort()).toEqual([
        'status',
        'trialExpiresAt',
        'trialStartedAt',
        'trialUsed',
      ]);
    });
  });

  describe('eligible accounts', () => {
    it.each([
      userStatus.INACTIVE,
      userStatus.SUSPENDED,
      userStatus.BLOCKED,
      userStatus.DELETED,
    ])(
      'rejects a %s account and leaves no subscription record',
      async (status) => {
        const userId = await createUser(client, status);

        await expect(
          trials.activateTrial(userId, meta, now),
        ).rejects.toMatchObject({ status: 403 });
        await expect(recordOf(userId)).resolves.toBeNull();
      },
    );

    it('lets a rejected account activate once it is active again', async () => {
      const userId = await createUser(client, userStatus.SUSPENDED);
      await expect(trials.activateTrial(userId, meta, now)).rejects.toThrow();

      await client.authUser.update({
        where: { id: userId },
        data: { status: userStatus.ACTIVE },
      });
      await expect(
        trials.activateTrial(userId, meta, now),
      ).resolves.toMatchObject({ status: 'TRIAL' });
    });
  });

  describe('disabled settings', () => {
    it.each([[{ trialEnabled: false }], [{ planEnabled: false }]])(
      'rejects activation when %p and does not use up the trial',
      async (settings) => {
        await plans.updateProPlan(settings, { actionedBy: adminId });
        const userId = await createUser(client);

        await expect(
          trials.activateTrial(userId, meta, now),
        ).rejects.toMatchObject({ status: 403 });
        await expect(recordOf(userId)).resolves.toBeNull();

        await plans.updateProPlan(
          { trialEnabled: true, planEnabled: true },
          { actionedBy: adminId },
        );
        await expect(
          trials.activateTrial(userId, meta, now),
        ).resolves.toMatchObject({ status: 'TRIAL' });
      },
    );
  });

  describe('repeated trials', () => {
    it('rejects a second activation and keeps the original dates', async () => {
      const userId = await createUser(client);
      await trials.activateTrial(userId, meta, now);

      for (const later of [daysFrom(now, 1), daysFrom(now, 30)]) {
        await expect(
          trials.activateTrial(userId, meta, later),
        ).rejects.toMatchObject({
          status: 409,
          message: 'The free trial has already been used',
        });
      }

      await expect(recordOf(userId)).resolves.toMatchObject({
        trialStartedAt: now,
        trialExpiresAt: daysFrom(now, 7),
      });
      await expect(
        client.activityLogEvent.count({
          where: { tableName: 'UserSubscription', actionedBy: userId },
        }),
      ).resolves.toBe(1);
    });

    it('grants exactly one trial to concurrent activation requests', async () => {
      const userId = await createUser(client);

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          trials.activateTrial(userId, meta, daysFrom(now, i)),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(7);
      for (const r of rejected) {
        expect(r.reason).toMatchObject({ status: 409 });
      }
      const record = await recordOf(userId);
      expect(record?.trialExpiresAt?.getTime()).toBe(
        (record?.trialStartedAt?.getTime() ?? 0) + 7 * 86_400_000,
      );
    });
  });

  describe('users with paid Pro history (fixtures)', () => {
    it.each([
      [
        'an active monthly term',
        {
          billingInterval: BillingInterval.MONTHLY,
          startedAt: daysFrom(now, -10),
        },
      ],
      [
        'a canceled term that is still running',
        {
          billingInterval: BillingInterval.MONTHLY,
          startedAt: daysFrom(now, -10),
          canceledAt: daysFrom(now, -2),
        },
      ],
      [
        'an expired monthly term',
        {
          billingInterval: BillingInterval.MONTHLY,
          startedAt: daysFrom(now, -60),
        },
      ],
      [
        'an expired yearly term',
        {
          billingInterval: BillingInterval.YEARLY,
          startedAt: daysFrom(now, -400),
        },
      ],
    ])(
      'rejects a never-trialed user with %s and leaves the record unchanged',
      async (_case, term) => {
        const userId = await createUser(client);
        const before = await givenPaidProHistory(client, userId, term, now);

        await expect(
          trials.activateTrial(userId, meta, now),
        ).rejects.toMatchObject({
          status: 409,
          message:
            'The free trial is only available to accounts that have never subscribed to Pro',
        });
        await expect(recordOf(userId)).resolves.toEqual(before);
      },
    );
  });

  describe('failed activation does not use up the trial', () => {
    it.each([
      ['a new user', false],
      ['a user with an unused record', true],
    ])(
      'rolls back for %s when a later step fails, and a retry succeeds',
      async (_case, withRecord) => {
        const userId = await createUser(client);
        if (withRecord) await givenFreeRecord(client, userId);
        const before = await recordOf(userId);

        const failingLog = mock<ActivityLogService>();
        failingLog.logActivity.mockRejectedValue(new Error('audit store down'));
        const failing = new SubscriptionTrialService(prisma, plans, failingLog);

        await expect(failing.activateTrial(userId, meta, now)).rejects.toThrow(
          'audit store down',
        );
        await expect(recordOf(userId)).resolves.toEqual(before);

        await expect(
          trials.activateTrial(userId, meta, daysFrom(now, 1)),
        ).resolves.toMatchObject({
          trialStartedAt: daysFrom(now, 1).toISOString(),
          trialExpiresAt: daysFrom(now, 8).toISOString(),
        });
      },
    );
  });
});
