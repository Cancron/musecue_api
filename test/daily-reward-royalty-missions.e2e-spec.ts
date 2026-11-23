// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { userRole } from '@prisma/client';
import { LoyaltyMissionProgressService } from '../src/daily-rewards/missions/loyalty-mission-progress.service';
import {
  expectConsistentLedger,
  givenCreditsInPostgres,
} from './support/credit-fixtures';
import request from 'supertest';
import {
  bearerOf,
  createAccount,
  dataOf,
  listen,
  messageOf,
  nextTestIp,
  type TestAccount,
} from './support/discount-fixtures';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  eventually,
  photo,
  type TestApplication,
} from './support/infrastructure-flows';
import {
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';

jest.setTimeout(300_000);

const ADMIN_MISSIONS = '/v1/admin/loyalty-missions';
const MISSIONS = '/v1/loyalty-missions';
const AWARDS = '/v1/loyalty-missions/awards';

interface MissionView {
  id: string;
  title: string;
  description: string | null;
  recurrence: 'ONCE' | 'WEEKLY' | 'MONTHLY';
  requiredCompletions: number;
  rewardCredits: number;
  active: boolean;
  startsAt: string;
  awards: number;
}
interface ProgressView {
  id: string;
  recurrence: string;
  requiredCompletions: number;
  period: { key: string; startsAt: string; endsAt: string | null };
  completions: number;
  remainingCompletions: number;
  completed: boolean;
  award: { id: string; credits: number } | null;
}
interface OverviewView {
  verifiedCompletions: { total: number; thisWeek: number; thisMonth: number };
  missions: ProgressView[];
  totalEarnedCredits: number;
}
interface AwardView {
  id: string;
  missionId: string;
  title: string;
  periodKey: string;
  credits: number;
}

/**
 * Loyalty missions through the complete application (HTTP, the makeup
 * workflow with the mock AI worker, PostgreSQL): administrators define
 * one-time or multi-step missions, once ever or per UTC week or month;
 * users are rewarded with MISSION_REWARD credits for verified makeup
 * completions (every guide step completed), once per mission and period,
 * whatever the repetition, concurrency or restarts, and separately from
 * the daily reward cap.
 */
describeWithDatabase(
  'Loyalty missions (PostgreSQL, full stack, makeup workflow)',
  () => {
    let schema: string;
    let ctx: TestApplication;
    let admin: TestAccount;

    /** Requests as `account` (or anonymously), from a new client address. */
    const as = (_: TestApplication, account?: TestAccount) => {
      const prepare = (req: request.Test) => {
        req.set('X-Forwarded-For', nextTestIp());
        return account ? req.set('Authorization', bearerOf(account)) : req;
      };
      const server = () => request(ctx.app.getHttpServer());
      return {
        get: (path: string) => prepare(server().get(path)),
        post: (path: string) => prepare(server().post(path)),
        patch: (path: string) => prepare(server().patch(path)),
      };
    };

    const mission = async (body: Record<string, unknown>) =>
      dataOf<MissionView>(
        await as(ctx, admin)
          .post(ADMIN_MISSIONS)
          .send({ title: 'Mission', ...body })
          .expect(201),
      );
    /** Missions apply to every user: each test starts with none active. */
    const deactivateAll = () =>
      ctx.client.loyaltyMission.updateMany({
        where: { active: true },
        data: { active: false },
      });
    const overview = async (account: TestAccount) =>
      dataOf<OverviewView>(await as(ctx, account).get(MISSIONS).expect(200));
    const progressOf = async (account: TestAccount, missionId: string) =>
      (await overview(account)).missions.find((m) => m.id === missionId)!;
    const missionCredits = async (authId: string) =>
      (
        await ctx.client.creditAllocation.findMany({
          where: { authId, source: 'MISSION_REWARD' },
          orderBy: { grantedAt: 'asc' },
        })
      ).map((a) => a.amount.toFixed());
    const awardsOf = (authId: string) =>
      ctx.client.loyaltyMissionAward.findMany({
        where: { authId },
        orderBy: [{ periodStart: 'asc' }, { awardedAt: 'asc' }],
      });

    /** A user with credits to start makeup sessions. */
    const newUser = async () => {
      const user = await createAccount(ctx);
      await givenCreditsInPostgres(ctx.client, user.id, 'PURCHASE', '100');
      return user;
    };
    const waitForRun = (runId: string) =>
      eventually(
        async () => {
          const run = await ctx.client.aiRun.findUnique({
            where: { id: runId },
            select: { status: true },
          });
          if (run?.status === 'FAILED') throw new Error('AI run failed');
          return run?.status === 'COMPLETED';
        },
        60_000,
        `AI run ${runId}`,
      );
    /**
     * A makeup session up to its guide (analysis and guide generation by
     * the mock AI worker); returns the guide's step ids in order.
     */
    const guidedSession = async (user: TestAccount) => {
      const api = () => as(ctx, user);
      const sessionId = dataOf<{ id: string }>(
        await api().post('/v1/sessions').expect(201),
      ).id;
      await api()
        .post(`/v1/sessions/${sessionId}/images`)
        .field('purpose', 'INITIAL_ANALYSIS')
        .attach('image', await photo(), {
          filename: 'face.jpg',
          contentType: 'image/jpeg',
        })
        .expect(201);
      await api()
        .patch(`/v1/sessions/${sessionId}/preferences`)
        .send({ vibe: 'natural', timeMinutes: 10 })
        .expect(200);
      const analysis = dataOf<{ id: string }>(
        await api()
          .post(`/v1/sessions/${sessionId}/analyze`)
          .set('Idempotency-Key', `analysis-${sessionId}`)
          .expect(201),
      );
      await waitForRun(analysis.id);
      const ready = dataOf<{ recommendations: Array<{ id: string }> }>(
        await api().get(`/v1/sessions/${sessionId}`).expect(200),
      );
      const guide = dataOf<{ id: string }>(
        await api()
          .post(
            `/v1/sessions/${sessionId}/recommendations/${ready.recommendations[0].id}/select`,
          )
          .set('Idempotency-Key', `guide-${sessionId}`)
          .expect(201),
      );
      await waitForRun(guide.id);
      const session = dataOf<{
        status: string;
        guide: { steps: Array<{ id: string; position: number }> };
      }>(await api().get(`/v1/sessions/${sessionId}`).expect(200));
      expect(session.status).toBe('GUIDE_READY');
      const steps = [...session.guide.steps]
        .sort((a, b) => a.position - b.position)
        .map((step) => step.id);
      expect(steps.length).toBeGreaterThan(1);
      return { sessionId, steps };
    };
    const completeStep = (
      user: TestAccount,
      stepId: string,
      outcome?: 'COMPLETED' | 'SKIPPED',
    ) =>
      as(ctx, user)
        .post(`/v1/guide-steps/${stepId}/complete`)
        .send(outcome ? { outcome } : {});
    /** A session completed with every step (optionally at time `at`). */
    const verifiedCompletion = async (user: TestAccount, at?: Date) => {
      const { sessionId, steps } = await guidedSession(user);
      if (at) freezeTime(at);
      try {
        for (const stepId of steps) {
          await completeStep(user, stepId).expect(201);
        }
      } finally {
        jest.useRealTimers();
      }
      return sessionId;
    };

    beforeAll(async () => {
      // Many AI runs (mock gateway): lift the development rate limit.
      process.env.AI_QUEUE_RATE_LIMIT_MAX = '1000';
      schema = await createSchema();
      await applyMigrations(schema, migrationNames());
      ctx = await bootApplication({ schema });
      await listen(ctx);
      admin = await createAccount(ctx, userRole.ADMIN);
    });

    beforeEach(async () => {
      await deactivateAll();
    });

    afterEach(() => jest.useRealTimers());

    afterAll(async () => {
      jest.useRealTimers();
      await ctx?.close();
      if (schema) await dropSchema(schema);
      delete process.env.AI_QUEUE_RATE_LIMIT_MAX;
    });

    describe('administration', () => {
      it('lets admins and super admins create, read and change missions; the requirement never changes', async () => {
        const superAdmin = await createAccount(ctx, userRole.SUPERADMIN);
        const created = dataOf<MissionView>(
          await as(ctx, superAdmin)
            .post(ADMIN_MISSIONS)
            .send({
              title: '  Three looks this week ',
              description: 'Finish three makeup sessions',
              recurrence: 'WEEKLY',
              requiredCompletions: 3,
              rewardCredits: 75,
            })
            .expect(201),
        );
        expect(created).toMatchObject({
          title: 'Three looks this week',
          description: 'Finish three makeup sessions',
          recurrence: 'WEEKLY',
          requiredCompletions: 3,
          rewardCredits: 75,
          active: true,
          awards: 0,
        });
        await expect(
          as(ctx, admin).get(`${ADMIN_MISSIONS}/${created.id}`).expect(200),
        ).resolves.toMatchObject({ body: { data: { id: created.id } } });
        expect(
          dataOf<MissionView[]>(
            await as(ctx, admin).get(ADMIN_MISSIONS).expect(200),
          ).some((m) => m.id === created.id),
        ).toBe(true);

        const updated = dataOf<MissionView>(
          await as(ctx, admin)
            .patch(`${ADMIN_MISSIONS}/${created.id}`)
            .send({
              title: 'Three looks',
              description: null,
              rewardCredits: 80,
              active: false,
            })
            .expect(200),
        );
        expect(updated).toMatchObject({
          title: 'Three looks',
          description: null,
          recurrence: 'WEEKLY',
          requiredCompletions: 3,
          rewardCredits: 80,
          active: false,
        });
        for (const body of [
          { recurrence: 'MONTHLY' },
          { requiredCompletions: 1 },
          { startsAt: new Date().toISOString() },
          {},
        ]) {
          await as(ctx, admin)
            .patch(`${ADMIN_MISSIONS}/${created.id}`)
            .send(body)
            .expect(400);
        }
        await as(ctx, admin)
          .patch(`${ADMIN_MISSIONS}/00000000-0000-4000-8000-000000000000`)
          .send({ active: true })
          .expect(404);
        await as(ctx, admin)
          .get(`${ADMIN_MISSIONS}/00000000-0000-4000-8000-000000000000`)
          .expect(404);

        await expect(
          ctx.client.loyaltyMission.findUniqueOrThrow({
            where: { id: created.id },
          }),
        ).resolves.toMatchObject({
          title: 'Three looks',
          rewardCredits: 80,
          active: false,
          requiredCompletions: 3,
        });
        await expect(
          ctx.client.loyaltyMission.update({
            where: { id: created.id },
            data: { requiredCompletions: 1 },
          }),
        ).rejects.toThrow('cannot change');
        await expect(
          ctx.client.activityLogEvent.count({
            where: { tableName: 'LoyaltyMission', recordId: created.id },
          }),
        ).resolves.toBe(2);
      });

      it('rejects invalid missions without storing anything', async () => {
        const before = await ctx.client.loyaltyMission.count();
        const valid = {
          title: 'Valid',
          recurrence: 'ONCE',
          requiredCompletions: 1,
          rewardCredits: 10,
        };
        const invalid: Array<Record<string, unknown>> = [
          {},
          { ...valid, title: '' },
          { ...valid, title: '   ' },
          { ...valid, title: 'x'.repeat(101) },
          { ...valid, title: 5 },
          { ...valid, description: 'x'.repeat(501) },
          { ...valid, recurrence: 'DAILY' },
          { ...valid, recurrence: undefined },
          { ...valid, requiredCompletions: 0 },
          { ...valid, requiredCompletions: -1 },
          { ...valid, requiredCompletions: 1.5 },
          { ...valid, requiredCompletions: '2' },
          { ...valid, requiredCompletions: 101 },
          { ...valid, rewardCredits: 0 },
          { ...valid, rewardCredits: -5 },
          { ...valid, rewardCredits: 2.5 },
          { ...valid, rewardCredits: 100_001 },
          { ...valid, rewardCredits: null },
          { ...valid, active: 'yes' },
          { ...valid, startsAt: '2030-01-01T00:00:00.000Z' },
          { ...valid, extra: 1 },
        ];
        for (const body of invalid) {
          await as(ctx, admin).post(ADMIN_MISSIONS).send(body).expect(400);
        }
        const existing = await mission({ ...valid, active: false });
        for (const body of [
          { rewardCredits: 0 },
          { rewardCredits: '10' },
          { title: '  ' },
          { active: null },
        ]) {
          await as(ctx, admin)
            .patch(`${ADMIN_MISSIONS}/${existing.id}`)
            .send(body)
            .expect(400);
        }
        expect(await ctx.client.loyaltyMission.count()).toBe(before + 1);
        await expect(
          ctx.client.loyaltyMission.findUniqueOrThrow({
            where: { id: existing.id },
          }),
        ).resolves.toMatchObject({ rewardCredits: 10, title: 'Valid' });
      });

      it('keeps mission administration away from regular users', async () => {
        const user = await createAccount(ctx);
        const existing = await mission({
          recurrence: 'ONCE',
          requiredCompletions: 1,
          rewardCredits: 10,
          active: false,
        });
        await as(ctx, user)
          .post(ADMIN_MISSIONS)
          .send({
            title: 'Mine',
            recurrence: 'ONCE',
            requiredCompletions: 1,
            rewardCredits: 100_000,
          })
          .expect(403);
        await as(ctx, user).get(ADMIN_MISSIONS).expect(403);
        await as(ctx, user).get(`${ADMIN_MISSIONS}/${existing.id}`).expect(403);
        await as(ctx, user)
          .patch(`${ADMIN_MISSIONS}/${existing.id}`)
          .send({ rewardCredits: 100_000, active: true })
          .expect(403);
        await as(ctx).get(ADMIN_MISSIONS).expect(401);
        await as(ctx).get(MISSIONS).expect(401);
        await as(ctx).get(AWARDS).expect(401);
        await expect(
          ctx.client.loyaltyMission.findUniqueOrThrow({
            where: { id: existing.id },
          }),
        ).resolves.toMatchObject({ rewardCredits: 10, active: false });
        await expect(
          ctx.client.loyaltyMission.count({ where: { title: 'Mine' } }),
        ).resolves.toBe(0);
      });
    });

    describe('rewards for verified completions', () => {
      it('rewards a one-time mission once, with non-expiring MISSION_REWARD credits outside the daily reward cap', async () => {
        const first = await mission({
          title: 'First look',
          recurrence: 'ONCE',
          requiredCompletions: 1,
          rewardCredits: 120,
        });
        const user = await newUser();
        expect(await progressOf(user, first.id)).toMatchObject({
          completions: 0,
          remainingCompletions: 1,
          completed: false,
          award: null,
        });

        await verifiedCompletion(user);
        expect(await missionCredits(user.id)).toEqual(['120']);
        await verifiedCompletion(user);
        expect(await missionCredits(user.id)).toEqual(['120']);

        const view = await overview(user);
        expect(view.verifiedCompletions.total).toBe(2);
        expect(view.totalEarnedCredits).toBe(120);
        expect(view.missions.find((m) => m.id === first.id)).toMatchObject({
          period: { key: 'once', endsAt: null },
          completions: 2,
          remainingCompletions: 0,
          completed: true,
          award: { credits: 120 },
        });
        expect(
          dataOf<AwardView[]>(await as(ctx, user).get(AWARDS).expect(200)),
        ).toMatchObject([
          {
            missionId: first.id,
            title: 'First look',
            periodKey: 'once',
            credits: 120,
          },
        ]);
        const [allocation] = await ctx.client.creditAllocation.findMany({
          where: { authId: user.id, source: 'MISSION_REWARD' },
        });
        expect(allocation.expiresAt).toBeNull();
        const balance = dataOf<{
          sources: Array<{
            source: string;
            granted: string;
            usableNow: boolean;
          }>;
        }>(await as(ctx, user).get('/v1/credits/balance').expect(200));
        expect(
          balance.sources.find((s) => s.source === 'MISSION_REWARD'),
        ).toMatchObject({ granted: '120', usableNow: true });

        // Mission credits never count towards the daily reward cap.
        const daily = dataOf<{ grantedCredits: number }>(
          await as(ctx, user).post('/v1/daily-rewards/claim').expect(201),
        );
        expect(daily.grantedCredits).toBe(10);
        expect(
          dataOf<{ claimedThisMonthCredits: number }>(
            await as(ctx, user).get('/v1/daily-rewards').expect(200),
          ).claimedThisMonthCredits,
        ).toBe(10);
        // Another user's rewards stay theirs.
        const other = await newUser();
        expect(
          dataOf<AwardView[]>(await as(ctx, other).get(AWARDS).expect(200)),
        ).toEqual([]);
        await expectConsistentLedger(ctx.client, user.id);
      });

      it('shows multi-step progress and rewards when the last required completion is verified', async () => {
        const multi = await mission({
          title: 'Three looks',
          recurrence: 'ONCE',
          requiredCompletions: 3,
          rewardCredits: 300,
        });
        const user = await newUser();
        await verifiedCompletion(user);
        expect(await progressOf(user, multi.id)).toMatchObject({
          completions: 1,
          remainingCompletions: 2,
          completed: false,
        });
        await verifiedCompletion(user);
        expect(await progressOf(user, multi.id)).toMatchObject({
          completions: 2,
          remainingCompletions: 1,
        });
        expect(await missionCredits(user.id)).toEqual([]);
        await verifiedCompletion(user);
        expect(await progressOf(user, multi.id)).toMatchObject({
          completions: 3,
          remainingCompletions: 0,
          completed: true,
          award: { credits: 300 },
        });
        expect(await missionCredits(user.id)).toEqual(['300']);
      });

      it('never rewards unfinished sessions or sessions with skipped steps', async () => {
        const single = await mission({
          recurrence: 'ONCE',
          requiredCompletions: 1,
          rewardCredits: 50,
        });
        const user = await newUser();
        // Unfinished: all steps but the last.
        const unfinished = await guidedSession(user);
        for (const stepId of unfinished.steps.slice(0, -1)) {
          await completeStep(user, stepId).expect(201);
        }
        // Finished, but with a skipped step.
        const skipped = await guidedSession(user);
        for (const [index, stepId] of skipped.steps.entries()) {
          await completeStep(
            user,
            stepId,
            index === 0 ? 'SKIPPED' : 'COMPLETED',
          ).expect(201);
        }
        await expect(
          ctx.client.makeupSession.findUniqueOrThrow({
            where: { id: skipped.sessionId },
          }),
        ).resolves.toMatchObject({ status: 'COMPLETED' });

        await expect(
          ctx.client.makeupCompletion.count({ where: { authId: user.id } }),
        ).resolves.toBe(0);
        expect(await missionCredits(user.id)).toEqual([]);
        expect(await progressOf(user, single.id)).toMatchObject({
          completions: 0,
          completed: false,
        });
        // PostgreSQL refuses to record them as verified completions.
        for (const session of [unfinished, skipped]) {
          await expect(
            ctx.client.makeupCompletion.create({
              data: {
                sessionId: session.sessionId,
                authId: user.id,
                completedAt: new Date(),
              },
            }),
          ).rejects.toThrow('Only a makeup session completed with every step');
        }
        // Finishing the unfinished one is a verified completion.
        await completeStep(user, unfinished.steps.at(-1)!).expect(201);
        expect(await missionCredits(user.id)).toEqual(['50']);
      });

      it('rewards weekly and monthly missions once per UTC week and month', async () => {
        const weekly = await mission({
          title: 'Weekly look',
          recurrence: 'WEEKLY',
          requiredCompletions: 1,
          rewardCredits: 20,
        });
        const monthly = await mission({
          title: 'Two looks a month',
          recurrence: 'MONTHLY',
          requiredCompletions: 2,
          rewardCredits: 200,
        });
        const user = await newUser();
        // Monday 2031-03-03 to Sunday 2031-03-09 is one UTC week.
        await verifiedCompletion(user, new Date('2031-03-03T00:00:05.000Z'));
        await verifiedCompletion(user, new Date('2031-03-09T23:59:00.000Z'));
        await verifiedCompletion(user, new Date('2031-03-10T08:00:00.000Z'));
        // Tuesday 2031-04-01: a new week and a new month.
        await verifiedCompletion(user, new Date('2031-04-01T08:00:00.000Z'));

        const awards = await awardsOf(user.id);
        expect(
          awards.map((a) => [
            a.missionId === weekly.id ? 'weekly' : 'monthly',
            a.periodKey,
            a.rewardCredits,
          ]),
        ).toEqual([
          ['monthly', '2031-03-01', 200],
          ['weekly', '2031-03-03', 20],
          ['weekly', '2031-03-10', 20],
          ['weekly', '2031-03-31', 20],
        ]);
        expect(
          (await missionCredits(user.id)).reduce((a, b) => a + Number(b), 0),
        ).toBe(260);

        // The current period's progress (as of 2031-04-02).
        freezeTime(new Date('2031-04-02T12:00:00.000Z'));
        const view = await overview(user);
        expect(view.verifiedCompletions).toEqual({
          total: 4,
          thisWeek: 1,
          thisMonth: 1,
        });
        expect(view.missions.find((m) => m.id === weekly.id)).toMatchObject({
          period: {
            key: '2031-03-31',
            startsAt: '2031-03-31T00:00:00.000Z',
            endsAt: '2031-04-07T00:00:00.000Z',
          },
          completions: 1,
          completed: true,
        });
        expect(view.missions.find((m) => m.id === monthly.id)).toMatchObject({
          period: { key: '2031-04-01', endsAt: '2031-05-01T00:00:00.000Z' },
          completions: 1,
          remainingCompletions: 1,
          completed: false,
        });
        jest.useRealTimers();
        await expectConsistentLedger(ctx.client, user.id);
      });

      it('applies reward changes to later periods only and never rewards inactive missions', async () => {
        const weekly = await mission({
          recurrence: 'WEEKLY',
          requiredCompletions: 1,
          rewardCredits: 30,
        });
        const user = await newUser();
        await verifiedCompletion(user, new Date('2032-06-07T10:00:00.000Z'));
        await as(ctx, admin)
          .patch(`${ADMIN_MISSIONS}/${weekly.id}`)
          .send({ rewardCredits: 45 })
          .expect(200);
        await verifiedCompletion(user, new Date('2032-06-14T10:00:00.000Z'));
        await as(ctx, admin)
          .patch(`${ADMIN_MISSIONS}/${weekly.id}`)
          .send({ active: false })
          .expect(200);
        await verifiedCompletion(user, new Date('2032-06-21T10:00:00.000Z'));

        expect(
          (await awardsOf(user.id)).map((a) => [a.periodKey, a.rewardCredits]),
        ).toEqual([
          ['2032-06-07', 30],
          ['2032-06-14', 45],
        ]);
        expect(await missionCredits(user.id)).toEqual(['30', '45']);
        // Inactive missions are not listed to users.
        expect(
          (await overview(user)).missions.some((m) => m.id === weekly.id),
        ).toBe(false);
      });
    });

    describe('once only', () => {
      it('records and rewards a completion once for repeated and concurrent final step requests', async () => {
        await mission({
          recurrence: 'ONCE',
          requiredCompletions: 1,
          rewardCredits: 70,
        });
        const user = await newUser();
        const { sessionId, steps } = await guidedSession(user);
        for (const stepId of steps.slice(0, -1)) {
          await completeStep(user, stepId).expect(201);
        }
        const last = steps.at(-1)!;
        const responses = await Promise.all(
          Array.from({ length: 6 }, () => completeStep(user, last)),
        );
        expect(responses.map((r) => r.status)).toEqual(
          Array<number>(6).fill(201),
        );
        await completeStep(user, last).expect(201);

        await expect(
          ctx.client.makeupCompletion.findMany({ where: { authId: user.id } }),
        ).resolves.toMatchObject([{ sessionId }]);
        expect(await missionCredits(user.id)).toEqual(['70']);
        await expect(
          ctx
            .get<LoyaltyMissionProgressService>(LoyaltyMissionProgressService)
            .processCompletion(sessionId),
        ).resolves.toEqual([]);
        expect(await missionCredits(user.id)).toEqual(['70']);
      });

      it('awards a multi-step mission once when its completions are verified at the same time', async () => {
        await mission({
          recurrence: 'ONCE',
          requiredCompletions: 2,
          rewardCredits: 90,
        });
        const user = await newUser();
        const sessions = [await guidedSession(user), await guidedSession(user)];
        for (const { steps } of sessions) {
          for (const stepId of steps.slice(0, -1)) {
            await completeStep(user, stepId).expect(201);
          }
        }
        await Promise.all(
          sessions.map(({ steps }) =>
            completeStep(user, steps.at(-1)!).expect(201),
          ),
        );
        await expect(
          ctx.client.makeupCompletion.count({ where: { authId: user.id } }),
        ).resolves.toBe(2);
        expect(await missionCredits(user.id)).toEqual(['90']);
        await expect(
          ctx
            .get<LoyaltyMissionProgressService>(LoyaltyMissionProgressService)
            .processPending(),
        ).resolves.toBe(0);
        expect(await missionCredits(user.id)).toEqual(['90']);
      });

      it('has PostgreSQL refuse mission awards and credits that were not earned', async () => {
        const target = await mission({
          recurrence: 'MONTHLY',
          requiredCompletions: 2,
          rewardCredits: 500,
        });
        const user = await newUser();
        const sessionId = await verifiedCompletion(
          user,
          new Date('2032-09-15T10:00:00.000Z'),
        );
        const award = (data: Record<string, unknown> = {}) =>
          ctx.client.loyaltyMissionAward.create({
            data: {
              missionId: target.id,
              authId: user.id,
              periodKey: '2032-09-01',
              periodStart: new Date('2032-09-01T00:00:00.000Z'),
              periodEnd: new Date('2032-10-01T00:00:00.000Z'),
              requiredCompletions: 2,
              rewardCredits: 500,
              awardedAt: new Date(),
              ...data,
            },
          });
        // One completion of the two required.
        await expect(award()).rejects.toThrow(
          'A mission is awarded only once its completions are recorded',
        );
        // Not a period of the mission's recurrence.
        await expect(
          award({
            periodKey: '2032-09-15',
            periodStart: new Date('2032-09-15T00:00:00.000Z'),
          }),
        ).rejects.toThrow("period of the mission's recurrence");
        const wallet = await ctx.client.creditWallet.findUniqueOrThrow({
          where: { authId: user.id },
        });
        await expect(
          ctx.client.creditAllocation.create({
            data: {
              walletId: wallet.id,
              authId: user.id,
              source: 'MISSION_REWARD',
              sourceReference:
                'loyalty-mission:00000000-0000-4000-8000-000000000000',
              amount: 500,
              remaining: 500,
              grantedAt: new Date(),
            },
          }),
        ).rejects.toThrow('Mission credits require a mission award');
        // Completions cannot be rewritten.
        await expect(
          ctx.client.makeupCompletion.update({
            where: { sessionId },
            data: { completedAt: new Date('2032-09-16T10:00:00.000Z') },
          }),
        ).rejects.toThrow('Makeup completions cannot be changed');
        expect(await missionCredits(user.id)).toEqual([]);
        await expect(
          ctx.client.makeupCompletion.findUniqueOrThrow({
            where: { sessionId },
          }),
        ).resolves.toMatchObject({ processedAt: expect.any(Date) as unknown });
      });
    });

    describe('restarts', () => {
      const previous = process.env.LOYALTY_MISSION_SWEEP_ENABLED;
      afterEach(() => {
        if (previous === undefined) {
          delete process.env.LOYALTY_MISSION_SWEEP_ENABLED;
        } else {
          process.env.LOYALTY_MISSION_SWEEP_ENABLED = previous;
        }
      });

      it('rewards a completion whose evaluation was interrupted after a restart, once', async () => {
        const target = await mission({
          recurrence: 'ONCE',
          requiredCompletions: 1,
          rewardCredits: 65,
        });
        const user = await newUser();
        const { sessionId, steps } = await guidedSession(user);
        // The process stops between recording the completion and evaluating
        // the missions.
        const progress = ctx.get<LoyaltyMissionProgressService>(
          LoyaltyMissionProgressService,
        );
        const evaluate = jest
          .spyOn(progress, 'processCompletion')
          .mockRejectedValueOnce(new Error('process stopped'));
        for (const stepId of steps) {
          await completeStep(user, stepId).expect(201);
        }
        evaluate.mockRestore();
        await expect(
          ctx.client.makeupCompletion.findUniqueOrThrow({
            where: { sessionId },
          }),
        ).resolves.toMatchObject({ processedAt: null });
        expect(await missionCredits(user.id)).toEqual([]);

        await ctx.close();
        process.env.LOYALTY_MISSION_SWEEP_ENABLED = 'true';
        ctx = await bootApplication({ schema });
        await listen(ctx);
        await eventually(
          async () => (await missionCredits(user.id)).length === 1,
          30_000,
          'the mission reward after the restart',
        );
        // Further sweeps and restarts change nothing.
        await Promise.all([
          ctx
            .get<LoyaltyMissionProgressService>(LoyaltyMissionProgressService)
            .processPending(),
          ctx
            .get<LoyaltyMissionProgressService>(LoyaltyMissionProgressService)
            .processCompletion(sessionId),
        ]);
        await ctx.close();
        ctx = await bootApplication({ schema });
        await listen(ctx);
        expect(await missionCredits(user.id)).toEqual(['65']);
        expect(await progressOf(user, target.id)).toMatchObject({
          completed: true,
          award: { credits: 65 },
        });
        expect(
          messageOf(
            await as(ctx, admin)
              .patch(`${ADMIN_MISSIONS}/${target.id}`)
              .send({ requiredCompletions: 2 })
              .expect(400),
          ),
        ).toBeDefined();
      });
    });
  },
);
