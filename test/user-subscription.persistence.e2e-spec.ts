import { PrismaPg } from '@prisma/adapter-pg';
import {
  BillingInterval,
  Prisma,
  PrismaClient,
  SubscriptionStatus,
} from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { addBillingInterval } from '../src/subscription/billing.validation';
import { SubscriptionAccessService } from '../src/subscription/subscription-access.service';
import { SubscriptionPlanService } from '../src/subscription/subscription-plan.service';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import {
  givenProPurchased,
  givenProRenewed,
} from './support/subscription-fixtures';

jest.setTimeout(60_000);

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));

describeWithDatabase('UserSubscription model (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  let access: SubscriptionAccessService;
  let userId: string;

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    client = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: TEST_DATABASE_URL as string },
        { schema },
      ),
    });
    const prisma = client as unknown as PrismaService;
    access = new SubscriptionAccessService(
      prisma,
      new SubscriptionPlanService(
        prisma,
        new ActivityLogService(prisma, mock<CustomLoggerService>()),
      ),
    );
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
  });

  let sequence = 0;
  beforeEach(async () => {
    sequence += 1;
    const user = await client.authUser.create({
      data: {
        email: `user${sequence}@example.com`,
        password: 'not-a-real-hash',
        username: `user${sequence}`,
        // A user who can log in (login requires a verified email).
        verified: true,
      },
    });
    userId = user.id;
  });

  describe('relationship', () => {
    it('creates a FREE record with defaults, reachable from the user', async () => {
      await client.userSubscription.create({ data: { authId: userId } });

      const user = await client.authUser.findUniqueOrThrow({
        where: { id: userId },
        include: { subscription: true },
      });
      expect(user.subscription).toMatchObject({
        authId: userId,
        status: SubscriptionStatus.FREE,
        trialUsed: false,
        trialStartedAt: null,
        trialExpiresAt: null,
        billingInterval: null,
        proStartedAt: null,
        proExpiresAt: null,
        proCanceledAt: null,
      });
    });

    it('allows only one record per user', async () => {
      await client.userSubscription.create({ data: { authId: userId } });
      await expect(
        client.userSubscription.create({ data: { authId: userId } }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('rejects a record for a user that does not exist', async () => {
      await expect(
        client.userSubscription.create({ data: { authId: 'missing-user' } }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('is deleted together with its user', async () => {
      await client.userSubscription.create({ data: { authId: userId } });
      await client.authUser.delete({ where: { id: userId } });
      await expect(
        client.userSubscription.count({ where: { authId: userId } }),
      ).resolves.toBe(0);
    });
  });

  describe('consistency constraints', () => {
    const trial = {
      trialUsed: true,
      trialStartedAt: day(0),
      trialExpiresAt: day(7),
    };
    const pro = {
      billingInterval: BillingInterval.MONTHLY,
      proStartedAt: day(0),
      proExpiresAt: day(30),
    };

    it.each<
      [string, Omit<Prisma.UserSubscriptionUncheckedCreateInput, 'authId'>]
    >([
      [
        'a trial start without an expiry',
        { status: 'TRIAL', trialUsed: true, trialStartedAt: day(0) },
      ],
      [
        'a trial that ends before it starts',
        {
          status: 'TRIAL',
          trialUsed: true,
          trialStartedAt: day(7),
          trialExpiresAt: day(0),
        },
      ],
      [
        'a started trial not marked as used',
        { status: 'TRIAL', trialStartedAt: day(0), trialExpiresAt: day(7) },
      ],
      [
        'a billing interval without Pro dates',
        { status: 'FREE', billingInterval: BillingInterval.YEARLY },
      ],
      [
        'Pro dates without a billing interval',
        { status: 'PRO', proStartedAt: day(0), proExpiresAt: day(30) },
      ],
      [
        'a Pro term that ends before it starts',
        { status: 'PRO', ...pro, proExpiresAt: day(0) },
      ],
      [
        'a cancellation without a Pro term',
        { status: 'EXPIRED', trialUsed: true, proCanceledAt: day(1) },
      ],
      ['FREE with a used trial', { status: 'FREE', trialUsed: true }],
      ['FREE with a Pro term', { status: 'FREE', ...pro }],
      ['TRIAL without trial dates', { status: 'TRIAL' }],
      ['PRO without a Pro term', { status: 'PRO', ...trial }],
      ['EXPIRED without any history', { status: 'EXPIRED' }],
    ])('rejects %s', async (_case, data) => {
      await expect(
        client.userSubscription.create({ data: { authId: userId, ...data } }),
      ).rejects.toThrow(/UserSubscription_|check constraint/);
    });

    it('accepts a full lifecycle: trial, expiry, purchase, renewal, cancellation, repurchase', async () => {
      const where = { authId: userId };
      await client.userSubscription.create({ data: { authId: userId } });
      await client.userSubscription.update({
        where,
        data: { status: 'TRIAL', ...trial },
      });
      await client.userSubscription.update({
        where,
        data: { status: 'EXPIRED' },
      });
      // Paid terms go through verified payments (fixtures; no payment flow yet).
      const purchased = await givenProPurchased(client, userId, {
        billingInterval: 'MONTHLY',
        startedAt: day(10),
      });
      // Renewal starts exactly where the paid month ends (calendar expiry).
      await givenProRenewed(client, userId, {
        billingInterval: 'MONTHLY',
        periodStart: purchased.proExpiresAt!,
      });
      await client.userSubscription.update({
        where,
        data: { proCanceledAt: day(50) },
      });
      await client.userSubscription.update({
        where,
        data: { status: 'EXPIRED' },
      });
      const repurchased = await givenProPurchased(client, userId, {
        billingInterval: 'YEARLY',
        startedAt: day(90),
      });

      expect(repurchased).toMatchObject({
        status: 'PRO',
        trialUsed: true,
        trialStartedAt: day(0),
        billingInterval: 'YEARLY',
        proCanceledAt: null,
      });
    });
  });

  describe('access through SubscriptionAccessService', () => {
    it('follows the trial window, blocks a second trial, and restores access on purchase', async () => {
      await expect(access.canStartTrial(userId)).resolves.toBe(true);

      await client.userSubscription.create({
        data: {
          authId: userId,
          status: 'TRIAL',
          trialUsed: true,
          trialStartedAt: day(0),
          trialExpiresAt: day(7),
        },
      });
      await expect(access.getAccess(userId, day(3))).resolves.toMatchObject({
        status: 'TRIAL',
        hasProAccess: true,
      });
      await expect(access.getAccess(userId, day(7))).resolves.toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
      });
      await expect(access.canStartTrial(userId)).resolves.toBe(false);

      const paidUntil = addBillingInterval(day(8), 'MONTHLY');
      await givenProPurchased(client, userId, {
        billingInterval: 'MONTHLY',
        startedAt: day(8),
      });
      await expect(access.getAccess(userId, day(9))).resolves.toEqual({
        status: 'PRO',
        hasProAccess: true,
        accessSource: 'PRO',
        accessExpiresAt: paidUntil,
      });
      await expect(access.hasProAccess(userId, paidUntil)).resolves.toBe(false);
    });
  });
});
