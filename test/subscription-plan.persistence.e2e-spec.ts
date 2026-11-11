import { PrismaPg } from '@prisma/adapter-pg';
import { PlanCode, PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { ActivityLogService } from '../src/common/services/activity-log.service';
import type { CustomLoggerService } from '../src/common/services/custom-logger.service';
import type { PrismaService } from '../src/common/services/prisma.service';
import { SubscriptionPlanService } from '../src/subscription/subscription-plan.service';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';

jest.setTimeout(60_000);

/**
 * Runs SubscriptionPlanService against a real, fully migrated PostgreSQL
 * schema. "Restarting" means discarding the Prisma client and its connection
 * pool and creating a new one, as a new API process would.
 */
describeWithDatabase('SubscriptionPlan persistence (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  let service: SubscriptionPlanService;
  let adminId: string;

  const connect = () => {
    client = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: TEST_DATABASE_URL as string },
        { schema },
      ),
    });
    const prisma = client as unknown as PrismaService;
    service = new SubscriptionPlanService(
      prisma,
      new ActivityLogService(prisma, mock<CustomLoggerService>()),
    );
  };
  const restart = async () => {
    await client.$disconnect();
    connect();
  };
  const actor = () => ({ actionedBy: adminId, ip: '127.0.0.1' });

  beforeEach(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    connect();
    const admin = await client.authUser.create({
      data: {
        email: 'admin@example.com',
        password: 'not-a-real-hash',
        username: 'admin',
        role: 'ADMIN',
      },
    });
    adminId = admin.id;
  });

  afterEach(async () => {
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
  });

  it('serves the defaults from an empty table without writing a row', async () => {
    await expect(service.getProPlan()).resolves.toEqual({
      code: 'PRO',
      currency: 'USD',
      planEnabled: true,
      monthlyPriceUsdCents: 1900,
      yearlyPriceUsdCents: 19000,
      trialEnabled: true,
      trialDays: 7,
      updatedAt: null,
    });
    await expect(client.subscriptionPlan.count()).resolves.toBe(0);
  });

  it('fills unspecified fields from the database defaults on the first save', async () => {
    await service.updateProPlan({ yearlyPriceUsdCents: 18000 }, actor());

    await expect(
      client.subscriptionPlan.findUniqueOrThrow({
        where: { code: PlanCode.PRO },
      }),
    ).resolves.toMatchObject({
      planEnabled: true,
      monthlyPriceUsdCents: 1900,
      yearlyPriceUsdCents: 18000,
      trialEnabled: true,
      trialDays: 7,
    });
  });

  it('keeps partial updates and enable/disable flags across a restart', async () => {
    await service.updateProPlan({ monthlyPriceUsdCents: 2400 }, actor());
    await service.updateProPlan({ trialDays: 21 }, actor());
    await service.updateProPlan(
      { trialEnabled: false, planEnabled: false },
      actor(),
    );

    await restart();

    await expect(service.getProPlan()).resolves.toMatchObject({
      planEnabled: false,
      monthlyPriceUsdCents: 2400,
      yearlyPriceUsdCents: 19000,
      trialEnabled: false,
      trialDays: 21,
      updatedAt: expect.any(String) as unknown,
    });

    await service.updateProPlan(
      { trialEnabled: true, planEnabled: true },
      actor(),
    );
    await restart();

    await expect(service.getProPlan()).resolves.toMatchObject({
      planEnabled: true,
      trialEnabled: true,
      trialDays: 21,
    });
  });

  it('stores an audit event for each change, attributed to the administrator', async () => {
    await service.updateProPlan({ monthlyPriceUsdCents: 2400 }, actor());
    await service.updateProPlan({ planEnabled: false }, actor());

    const events = await client.activityLogEvent.findMany({
      where: { tableName: 'SubscriptionPlan' },
      orderBy: { createdAt: 'asc' },
      select: {
        action: true,
        actionedBy: true,
        details: {
          select: { fieldName: true, oldValue: true, newValue: true },
        },
      },
    });
    expect(events).toEqual([
      {
        action: 'create',
        actionedBy: adminId,
        details: [
          {
            fieldName: 'monthlyPriceUsdCents',
            oldValue: '1900',
            newValue: '2400',
          },
        ],
      },
      {
        action: 'update',
        actionedBy: adminId,
        details: [
          { fieldName: 'planEnabled', oldValue: 'true', newValue: 'false' },
        ],
      },
    ]);
  });

  it('rolls back the plan change when the audit record cannot be written', async () => {
    await service.updateProPlan({ monthlyPriceUsdCents: 2400 }, actor());

    // actionedBy is a foreign key to authUser, so an unknown ID fails the audit insert.
    await expect(
      service.updateProPlan(
        { monthlyPriceUsdCents: 9900 },
        { actionedBy: 'missing-user' },
      ),
    ).rejects.toMatchObject({ code: 'P2003' });

    await expect(service.getProPlan()).resolves.toMatchObject({
      monthlyPriceUsdCents: 2400,
    });
  });

  it('handles concurrent first saves without a duplicate-key failure', async () => {
    const results = await Promise.allSettled(
      [2000, 2100, 2200, 2300, 2400].map((price) =>
        service.updateProPlan({ monthlyPriceUsdCents: price }, actor()),
      ),
    );

    expect(results.map((result) => result.status)).toEqual(
      Array(5).fill('fulfilled'),
    );
    await expect(client.subscriptionPlan.count()).resolves.toBe(1);
  });
});
