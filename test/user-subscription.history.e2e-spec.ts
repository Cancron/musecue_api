import { PrismaPg } from '@prisma/adapter-pg';
import { BillingInterval, PrismaClient } from '@prisma/client';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import { addBillingInterval } from '../src/subscription/billing.validation';
import {
  createUser,
  daysFrom,
  givenPaidProHistory,
  givenProPurchased,
  givenProRenewed,
} from './support/subscription-fixtures';

jest.setTimeout(60_000);

/**
 * Database-level protection of subscription history (migration
 * 20260916120000_protect_subscription_history). These writes bypass the
 * application on purpose: the rules must hold for any code path.
 */
describeWithDatabase('UserSubscription history protection (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  const T0 = new Date('2026-03-01T09:30:00.000Z');

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    client = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: TEST_DATABASE_URL as string },
        { schema },
      ),
    });
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
  });

  const withTrial = async () => {
    const authId = await createUser(client);
    const record = await client.userSubscription.create({
      data: {
        authId,
        status: 'TRIAL',
        trialUsed: true,
        trialStartedAt: T0,
        trialExpiresAt: daysFrom(T0, 7),
      },
    });
    return { authId, record };
  };

  describe('trial history', () => {
    it.each([
      [
        'resetting it to FREE',
        {
          status: 'FREE' as const,
          trialUsed: false,
          trialStartedAt: null,
          trialExpiresAt: null,
        },
      ],
      ['clearing trialUsed', { status: 'EXPIRED' as const, trialUsed: false }],
      ['extending the expiry', { trialExpiresAt: daysFrom(T0, 30) }],
      ['shortening the expiry', { trialExpiresAt: daysFrom(T0, 1) }],
      ['moving the start date', { trialStartedAt: daysFrom(T0, 1) }],
    ])('rejects %s', async (_case, data) => {
      const { authId, record } = await withTrial();
      await expect(
        client.userSubscription.update({ where: { authId }, data }),
      ).rejects.toThrow(/trial/);
      await expect(
        client.userSubscription.findUniqueOrThrow({ where: { authId } }),
      ).resolves.toEqual(record);
    });

    it('rejects un-using a trial that was marked used without dates (passes every CHECK, so only the trigger can stop it)', async () => {
      const authId = await createUser(client);
      await client.userSubscription.create({
        data: { authId, status: 'EXPIRED', trialUsed: true },
      });
      await expect(
        client.userSubscription.update({
          where: { authId },
          data: { status: 'FREE', trialUsed: false },
        }),
      ).rejects.toThrow(/trial usage cannot be reset/);
    });

    it('allows the status snapshot to move to EXPIRED and then PRO', async () => {
      const { authId } = await withTrial();
      await client.userSubscription.update({
        where: { authId },
        data: { status: 'EXPIRED' },
      });
      await expect(
        givenProPurchased(client, authId, {
          billingInterval: BillingInterval.MONTHLY,
          startedAt: daysFrom(T0, 8),
        }),
      ).resolves.toMatchObject({
        status: 'PRO',
        trialStartedAt: T0,
        trialExpiresAt: daysFrom(T0, 7),
      });
    });
  });

  describe('paid Pro history', () => {
    const term = {
      billingInterval: BillingInterval.MONTHLY,
      startedAt: daysFrom(T0, -60),
    };

    it('rejects clearing a paid term', async () => {
      const authId = await createUser(client);
      await givenPaidProHistory(client, authId, term, T0);
      await expect(
        client.userSubscription.update({
          where: { authId },
          data: {
            status: 'FREE',
            billingInterval: null,
            proStartedAt: null,
            proExpiresAt: null,
          },
        }),
      ).rejects.toThrow(/paid Pro history cannot be cleared/);
    });

    it('allows renewal, cancellation and repurchase', async () => {
      const authId = await createUser(client);
      await givenPaidProHistory(client, authId, term, T0);
      const oneYear = addBillingInterval(T0, BillingInterval.YEARLY);
      const twoYears = addBillingInterval(oneYear, BillingInterval.YEARLY);
      await givenProPurchased(client, authId, {
        billingInterval: BillingInterval.YEARLY,
        startedAt: T0,
      });
      await client.userSubscription.update({
        where: { authId },
        data: { proCanceledAt: daysFrom(T0, 10) },
      });
      await client.userSubscription.update({
        where: { authId },
        data: { proCanceledAt: null },
      });
      await expect(
        givenProRenewed(client, authId, {
          billingInterval: BillingInterval.YEARLY,
          periodStart: oneYear,
        }),
      ).resolves.toMatchObject({
        billingInterval: 'YEARLY',
        proExpiresAt: twoYears,
        proCanceledAt: null,
      });
    });
  });

  describe('deletion', () => {
    it('rejects deleting the record while its user exists', async () => {
      const { authId } = await withTrial();
      await expect(
        client.userSubscription.delete({ where: { authId } }),
      ).rejects.toThrow(/cannot be deleted while its user exists/);
      await expect(
        client.userSubscription.deleteMany({ where: { authId } }),
      ).rejects.toThrow(/cannot be deleted while its user exists/);
      await expect(
        client.userSubscription.count({ where: { authId } }),
      ).resolves.toBe(1);
    });

    it('still removes the record when the user is deleted', async () => {
      const { authId } = await withTrial();
      await client.authUser.delete({ where: { id: authId } });
      await expect(
        client.userSubscription.count({ where: { authId } }),
      ).resolves.toBe(0);
    });
  });
});
