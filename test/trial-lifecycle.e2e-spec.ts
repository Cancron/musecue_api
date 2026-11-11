import {
  Controller,
  Get,
  Global,
  INestApplication,
  Module,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { BillingInterval, PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { UserRole } from '../src/auth/interfaces/auth.interface';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
import config from '../src/common/config/app.config';
import { AllExceptionsFilter } from '../src/common/filters/all-exception.filter';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { CustomLoggerService } from '../src/common/services/custom-logger.service';
import { PrismaService } from '../src/common/services/prisma.service';
import { RedisService } from '../src/common/services/redis.service';
import {
  ProAccessGuard,
  type ProAccessRequest,
} from '../src/subscription/pro-access.guard';
import { addBillingInterval } from '../src/subscription/billing.validation';
import { SubscriptionModule } from '../src/subscription/subscription.module';
import { freezeTime } from './support/freeze-time';
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
  givenPaidProHistory,
  givenProPurchased,
  givenProRenewed,
} from './support/subscription-fixtures';

jest.setTimeout(120_000);

@UseGuards(AuthGuard, ProAccessGuard)
@Controller('v1/test-pro-feature')
class ProFeatureTestController {
  @Get()
  use(@Req() req: ProAccessRequest) {
    return { accessSource: req.proAccess.accessSource };
  }
}

type Data = Record<string, unknown> & {
  trial: Record<string, unknown>;
  pro: Record<string, unknown>;
};

/**
 * End-to-end scenarios for the trial system: configuration changes,
 * concurrency, expiry, and interaction with paid Pro. Everything goes through
 * the real HTTP endpoints, guards and services against PostgreSQL.
 */
describeWithDatabase(
  'Trial lifecycle scenarios (PostgreSQL, full stack)',
  () => {
    let app: INestApplication<App>;
    let schema: string;
    let client: PrismaClient;
    let originalSecret: string;
    let adminId: string;
    const redis = mock<RedisService>();
    const tokens = new AuthUtilsService(mock<RedisService>());
    const T0 = new Date('2026-03-01T09:30:00.000Z');
    const day = (n: number, ms = 0) => new Date(daysFrom(T0, n).getTime() + ms);

    const bearer = (userId: string, role: UserRole = UserRole.USER) =>
      `Bearer ${tokens.createAccessToken({ userId, role, tokenVersion: 1 })}`;
    const http = () => request(app.getHttpServer());

    const activate = (userId: string, now: Date) => {
      freezeTime(now);
      return http()
        .post('/v1/subscription/trial')
        .set('Authorization', bearer(userId));
    };
    const status = async (userId: string, now: Date): Promise<Data> => {
      freezeTime(now);
      const response = await http()
        .get('/v1/subscription')
        .set('Authorization', bearer(userId))
        .expect(200);
      return (response.body as { data: Data }).data;
    };
    const usePro = (userId: string, now: Date) => {
      freezeTime(now);
      return http()
        .get('/v1/test-pro-feature')
        .set('Authorization', bearer(userId));
    };
    const setPlan = async (body: object, now: Date) => {
      freezeTime(now);
      await http()
        .patch('/v1/admin/subscription-plan')
        .set('Authorization', bearer(adminId, UserRole.ADMIN))
        .send(body)
        .expect(200);
    };
    const recordOf = (authId: string) =>
      client.userSubscription.findUniqueOrThrow({ where: { authId } });

    beforeAll(async () => {
      schema = await createSchema();
      await applyMigrations(schema, migrationNames());
      client = new PrismaClient({
        adapter: new PrismaPg(
          { connectionString: TEST_DATABASE_URL as string },
          { schema },
        ),
      });

      @Global()
      @Module({
        providers: [
          { provide: PrismaService, useValue: client },
          {
            provide: CustomLoggerService,
            useValue: mock<CustomLoggerService>(),
          },
        ],
        exports: [PrismaService, CustomLoggerService],
      })
      class DatabaseTestModule {}

      @Module({
        imports: [SubscriptionModule],
        controllers: [ProFeatureTestController],
        providers: [AuthGuard, RedisService],
      })
      class ProFeatureTestModule {}

      originalSecret = config.jwt_access_secret;
      config.jwt_access_secret = 'trial-lifecycle-e2e-secret';
      const moduleRef = await Test.createTestingModule({
        imports: [DatabaseTestModule, SubscriptionModule, ProFeatureTestModule],
      })
        .overrideProvider(RedisService)
        .useValue(redis)
        .compile();
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
      // Listen on a real port so parallel requests share one stable server.
      await app.listen(0, '127.0.0.1');
      adminId = await createUser(client);
    });

    afterAll(async () => {
      jest.useRealTimers();
      await app?.close();
      await client?.$disconnect();
      if (schema) await dropSchema(schema);
      config.jwt_access_secret = originalSecret;
    });

    beforeEach(async () => {
      redis.get.mockResolvedValue(1 as never);
      jest.useRealTimers();
      await client.subscriptionPlan.deleteMany(); // back to defaults: enabled, 7 days
    });

    afterEach(() => jest.useRealTimers());

    describe('configuration changes', () => {
      it('a longer trial duration applies only to trials started after the change', async () => {
        const existing = await createUser(client);
        await activate(existing, T0).expect(201);
        const before = await recordOf(existing);

        await setPlan({ trialDays: 30 }, day(1));

        await expect(recordOf(existing)).resolves.toEqual(before);
        await usePro(existing, day(7, -1)).expect(200);
        await usePro(existing, day(7)).expect(403);
        expect(await status(existing, day(7))).toMatchObject({
          status: 'EXPIRED',
          trial: { expiresAt: day(7).toISOString() },
        });

        const newcomer = await createUser(client);
        const response = await activate(newcomer, day(2)).expect(201);
        expect(response.body).toMatchObject({
          data: { trialExpiresAt: day(32).toISOString() },
        });
      });

      it('a shorter trial duration does not cut an existing trial short', async () => {
        await setPlan({ trialDays: 14 }, T0);
        const existing = await createUser(client);
        await activate(existing, T0).expect(201);

        await setPlan({ trialDays: 1 }, day(1));

        await usePro(existing, day(10)).expect(200);
        await usePro(existing, day(14, -1)).expect(200);
        await usePro(existing, day(14)).expect(403);
      });

      it.each([[{ trialEnabled: false }], [{ planEnabled: false }]])(
        'disabling with %p blocks new trials but keeps existing trials active until they expire',
        async (disable) => {
          const existing = await createUser(client);
          const newcomer = await createUser(client);
          await activate(existing, T0).expect(201);

          await setPlan(disable, day(1));

          await activate(newcomer, day(2)).expect(403);
          expect(await status(newcomer, day(2))).toMatchObject({
            status: 'FREE',
            trial: { eligible: false, used: false },
          });
          await expect(
            client.userSubscription.count({ where: { authId: newcomer } }),
          ).resolves.toBe(0);

          expect(await status(existing, day(3))).toMatchObject({
            status: 'TRIAL',
            hasProAccess: true,
          });
          await usePro(existing, day(7, -1)).expect(200);
          await usePro(existing, day(7)).expect(403);

          // Re-enabling lets the blocked user start a trial; nothing was used up.
          await setPlan({ trialEnabled: true, planEnabled: true }, day(8));
          await activate(newcomer, day(8)).expect(201);
        },
      );
    });

    describe('concurrent activation', () => {
      it('grants one trial to simultaneous first activations: one record, one audit event, a 7-day expiry', async () => {
        const userId = await createUser(client);
        freezeTime(T0);
        const responses = await Promise.all(
          Array.from({ length: 12 }, () =>
            http()
              .post('/v1/subscription/trial')
              .set('Authorization', bearer(userId)),
          ),
        );

        const statuses = responses.map((r) => r.status).sort();
        expect(statuses).toEqual([201, ...Array<number>(11).fill(409)]);
        await expect(
          client.userSubscription.count({ where: { authId: userId } }),
        ).resolves.toBe(1);
        await expect(recordOf(userId)).resolves.toMatchObject({
          trialStartedAt: T0,
          trialExpiresAt: day(7),
        });
        await expect(
          client.activityLogEvent.count({
            where: { tableName: 'UserSubscription', actionedBy: userId },
          }),
        ).resolves.toBe(1);
      });

      it('simultaneous repeat activations during a trial neither reset its history nor extend its expiry', async () => {
        const userId = await createUser(client);
        await activate(userId, T0).expect(201);
        const before = await recordOf(userId);

        freezeTime(day(5));
        const responses = await Promise.all(
          Array.from({ length: 10 }, () =>
            http()
              .post('/v1/subscription/trial')
              .set('Authorization', bearer(userId)),
          ),
        );

        expect(responses.every((r) => r.status === 409)).toBe(true);
        await expect(recordOf(userId)).resolves.toEqual(before);
      });

      it('simultaneous activations by different users each get their own trial', async () => {
        const users = await Promise.all(
          Array.from({ length: 5 }, () => createUser(client)),
        );
        freezeTime(T0);
        const responses = await Promise.all(
          users.map((userId) =>
            http()
              .post('/v1/subscription/trial')
              .set('Authorization', bearer(userId)),
          ),
        );
        expect(responses.map((r) => r.status)).toEqual(Array(5).fill(201));
        await expect(
          client.userSubscription.count({ where: { authId: { in: users } } }),
        ).resolves.toBe(5);
      });
    });

    describe('expiration', () => {
      it('stops Pro access at the exact expiry instant and reports the trial as used', async () => {
        const userId = await createUser(client);
        await activate(userId, T0).expect(201);

        await usePro(userId, day(7, -1)).expect(200);
        await usePro(userId, day(7)).expect(403);
        expect(await status(userId, day(7))).toMatchObject({
          status: 'EXPIRED',
          hasProAccess: false,
          trial: {
            eligible: false,
            ineligibleReason: 'TRIAL_ALREADY_USED',
            used: true,
            active: false,
            startedAt: T0.toISOString(),
            expiresAt: day(7).toISOString(),
          },
        });
      });

      it('never makes an expired trial eligible again: not later, not after a longer duration, not after toggling the trial', async () => {
        const userId = await createUser(client);
        await activate(userId, T0).expect(201);
        const expired = await recordOf(userId);

        await activate(userId, day(8)).expect(409);
        await setPlan({ trialDays: 365 }, day(9));
        await activate(userId, day(10)).expect(409);
        await usePro(userId, day(10)).expect(403);
        await setPlan({ trialEnabled: false }, day(11));
        await setPlan({ trialEnabled: true }, day(12));
        await activate(userId, day(13)).expect(409);
        await activate(userId, day(400)).expect(409);
        expect(await status(userId, day(400))).toMatchObject({
          status: 'EXPIRED',
          trial: { eligible: false, ineligibleReason: 'TRIAL_ALREADY_USED' },
        });

        await expect(recordOf(userId)).resolves.toEqual(expired);
      });
    });

    describe('trial and paid Pro together', () => {
      it('Pro bought during the trial keeps access continuous and leaves the trial history intact', async () => {
        const userId = await createUser(client);
        await activate(userId, T0).expect(201);
        const trialRecord = await recordOf(userId);

        // Purchase on day 3 of the 7-day trial (fixture: no payment system yet).
        const paidUntil = addBillingInterval(day(3), BillingInterval.MONTHLY);
        await givenProPurchased(client, userId, {
          billingInterval: BillingInterval.MONTHLY,
          startedAt: day(3),
        });

        for (const when of [
          day(3),
          day(6),
          day(7, -1),
          day(7),
          day(20),
          new Date(paidUntil.getTime() - 1),
        ]) {
          const response = await usePro(userId, when).expect(200);
          expect(response.body).toMatchObject({
            data: { accessSource: 'PRO' },
          });
        }

        const afterPurchase = await recordOf(userId);
        expect(afterPurchase).toMatchObject({
          trialUsed: trialRecord.trialUsed,
          trialStartedAt: trialRecord.trialStartedAt,
          trialExpiresAt: trialRecord.trialExpiresAt,
        });
        expect(await status(userId, day(10))).toMatchObject({
          status: 'PRO',
          accessSource: 'PRO',
          accessExpiresAt: paidUntil.toISOString(),
          trial: {
            used: true,
            active: false,
            startedAt: T0.toISOString(),
            expiresAt: day(7).toISOString(),
            eligible: false,
          },
          pro: { active: true, billingInterval: 'MONTHLY' },
        });

        // Trying the trial again changes nothing.
        await activate(userId, day(10)).expect(409);
        await expect(recordOf(userId)).resolves.toEqual(afterPurchase);
      });

      it('renewing Pro after a trial keeps the trial history, and access ends with the paid term', async () => {
        const userId = await createUser(client);
        await activate(userId, T0).expect(201);
        const monthEnd = addBillingInterval(day(7), BillingInterval.MONTHLY);
        const yearEnd = addBillingInterval(monthEnd, BillingInterval.YEARLY);
        await givenProPurchased(client, userId, {
          billingInterval: BillingInterval.MONTHLY,
          startedAt: day(7),
        });
        // Renewed (switching to yearly) exactly when the paid month ends.
        await givenProRenewed(client, userId, {
          billingInterval: BillingInterval.YEARLY,
          periodStart: monthEnd,
        });

        await usePro(userId, day(200)).expect(200);
        await usePro(userId, new Date(yearEnd.getTime() - 1)).expect(200);
        await usePro(userId, yearEnd).expect(403);
        expect(await status(userId, yearEnd)).toMatchObject({
          status: 'EXPIRED',
          trial: { used: true, startedAt: T0.toISOString(), eligible: false },
        });
        await activate(userId, daysFrom(yearEnd, 1)).expect(409);
      });
    });

    describe('paid Pro history without a trial', () => {
      it.each([
        [
          'an expired monthly term',
          {
            billingInterval: BillingInterval.MONTHLY,
            startedAt: day(-60),
          },
        ],
        [
          'a canceled term that has expired',
          {
            billingInterval: BillingInterval.MONTHLY,
            startedAt: day(-60),
            canceledAt: day(-45),
          },
        ],
        [
          'a yearly term that expired long ago',
          {
            billingInterval: BillingInterval.YEARLY,
            startedAt: day(-800),
          },
        ],
        [
          'a term that is still running',
          {
            billingInterval: BillingInterval.MONTHLY,
            startedAt: day(-5),
          },
        ],
      ])('refuses the free trial after %s', async (_case, term) => {
        const userId = await createUser(client);
        const before = await givenPaidProHistory(client, userId, term, T0);

        const response = await activate(userId, T0).expect(409);
        expect(response.body).toMatchObject({
          message:
            'The free trial is only available to accounts that have never subscribed to Pro',
        });
        expect(await status(userId, T0)).toMatchObject({
          trial: {
            eligible: false,
            ineligibleReason: 'HAS_PRO_HISTORY',
            used: false,
          },
        });
        await expect(recordOf(userId)).resolves.toEqual(before);
      });
    });
  },
);
