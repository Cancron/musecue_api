// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { userRole } from '@prisma/client';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import { DailyRewardSettingsService } from '../src/daily-rewards/daily-reward-settings.service';
import { expectConsistentLedger } from './support/credit-fixtures';
import {
  as,
  createAccount,
  dataOf,
  listen,
  messageOf,
  type TestAccount,
} from './support/discount-fixtures';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  type TestApplication,
} from './support/infrastructure-flows';
import {
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';

jest.setTimeout(180_000);

const CLAIM = '/v1/daily-rewards/claim';
const STATUS = '/v1/daily-rewards';
const SETTINGS = '/v1/admin/daily-reward-settings';
const CAP_REACHED =
  'The monthly limit of 600 daily reward credits has been reached';
const ALREADY_CLAIMED = "Today's daily reward has already been claimed";

interface ClaimView {
  id: string;
  claimDate: string;
  streakDay: number;
  rewardCredits: number;
  grantedCredits: number;
  claimedAt: string;
}
interface StatusView {
  today: string;
  month: string;
  claimedToday: boolean;
  todayClaim: ClaimView | null;
  currentStreakDays: number;
  nextRewardCredits: number;
  monthlyCapCredits: number;
  claimedThisMonthCredits: number;
  remainingThisMonthCredits: number;
}

/** Noon UTC of `day` (YYYY-MM-DD). */
const noon = (day: string) => new Date(`${day}T12:00:00.000Z`);
/**
 * Daily reward claims and the cap of 600 daily reward credits per user and
 * UTC calendar month, through the complete application against a migrated
 * PostgreSQL schema, with the clock moved by freezeTime.
 */
describeWithDatabase('Daily reward claims (PostgreSQL, full stack)', () => {
  let schema: string;
  let ctx: TestApplication;
  let admin: TestAccount;

  const claim = (account: TestAccount) => as(ctx, account).post(CLAIM);
  const status = async (account: TestAccount) =>
    dataOf<StatusView>(await as(ctx, account).get(STATUS).expect(200));
  /** Claims on `day` and returns the granted credits (0 if refused by the cap). */
  const claimOn = async (account: TestAccount, day: string) => {
    freezeTime(noon(day));
    const response = await claim(account);
    if (response.status === 409 && messageOf(response) === CAP_REACHED) {
      return 0;
    }
    expect(response.status).toBe(201);
    return dataOf<ClaimView>(response).grantedCredits;
  };
  /** DAILY_REWARD credits granted in the wallet, per UTC month (YYYY-MM). */
  const walletGrantsByMonth = async (authId: string) => {
    const allocations = await ctx.client.creditAllocation.findMany({
      where: { authId, source: 'DAILY_REWARD' },
    });
    const months: Record<string, number> = {};
    for (const allocation of allocations) {
      const month = allocation.sourceReference.slice(
        'daily-reward:'.length,
        'daily-reward:'.length + 7,
      );
      months[month] =
        (months[month] ?? 0) + Number(allocation.amount.toFixed());
    }
    return months;
  };
  const setSettings = (body: Record<string, number>) =>
    as(ctx, admin).patch(SETTINGS, body).expect(200);

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    ctx = await bootApplication({ schema });
    await listen(ctx);
    admin = await createAccount(ctx, userRole.ADMIN);
  });

  /** Back to the default settings (10, +10, at most 50). */
  beforeEach(async () => {
    await ctx.client.dailyRewardSettings.deleteMany();
    await ctx
      .get<DailyRewardSettingsService>(DailyRewardSettingsService)
      .ensureDefaults();
  });

  afterEach(() => jest.useRealTimers());

  afterAll(async () => {
    jest.useRealTimers();
    await ctx?.close();
    if (schema) await dropSchema(schema);
  });

  describe('claiming', () => {
    it('grants the day reward as never-expiring DAILY_REWARD credits, once per UTC day', async () => {
      const user = await createAccount(ctx);
      freezeTime(new Date('2031-01-05T00:00:00.000Z'));

      const response = await claim(user).expect(201);

      expect(dataOf(response)).toEqual({
        id: expect.any(String) as unknown,
        claimDate: '2031-01-05',
        streakDay: 1,
        rewardCredits: 10,
        grantedCredits: 10,
        claimedAt: '2031-01-05T00:00:00.000Z',
      });
      const [allocation, ...others] =
        await ctx.client.creditAllocation.findMany({
          where: { authId: user.id },
        });
      expect(others).toEqual([]);
      expect(allocation).toMatchObject({
        source: 'DAILY_REWARD',
        sourceReference: 'daily-reward:2031-01-05',
        expiresAt: null,
      });
      expect(allocation.amount.toFixed()).toBe('10');
      const balance = dataOf<{
        available: string;
        sources: Array<{ source: string; granted: string }>;
      }>(await as(ctx, user).get('/v1/credits/balance').expect(200));
      expect(balance.available).toBe('10');
      expect(
        balance.sources.find((s) => s.source === 'DAILY_REWARD'),
      ).toMatchObject({ granted: '10' });

      // Later the same UTC day: refused, nothing granted.
      freezeTime(new Date('2031-01-05T23:59:59.999Z'));
      expect(messageOf(await claim(user).expect(409))).toBe(ALREADY_CLAIMED);
      await expect(
        ctx.client.creditAllocation.count({ where: { authId: user.id } }),
      ).resolves.toBe(1);

      // The next UTC day continues the streak.
      freezeTime(new Date('2031-01-06T00:00:00.000Z'));
      await expect(claim(user).expect(201).then(dataOf)).resolves.toMatchObject(
        {
          streakDay: 2,
          rewardCredits: 20,
          grantedCredits: 20,
        },
      );
      await expectConsistentLedger(ctx.client, user.id);
    });

    it('rises 10, 20, 30, 40, 50, 50 over a streak and starts again after a missed day', async () => {
      const user = await createAccount(ctx);
      const granted: number[] = [];
      for (let day = 1; day <= 6; day += 1) {
        granted.push(await claimOn(user, `2031-03-0${day}`));
      }
      expect(granted).toEqual([10, 20, 30, 40, 50, 50]);

      // 2031-03-07 missed.
      freezeTime(noon('2031-03-08'));
      await expect(claim(user).expect(201).then(dataOf)).resolves.toMatchObject(
        {
          streakDay: 1,
          grantedCredits: 10,
        },
      );
    });

    it('makes the credits usable like purchased credits (a makeup session can be created)', async () => {
      const user = await createAccount(ctx);
      await as(ctx, user).post('/v1/sessions').expect(403);
      await claim(user).expect(201);
      await as(ctx, user).post('/v1/sessions').expect(201);
    });

    it('applies settings changes to later claims only', async () => {
      const user = await createAccount(ctx);
      expect(await claimOn(user, '2031-04-01')).toBe(10);
      await setSettings({
        startingRewardCredits: 25,
        dailyIncrementCredits: 5,
        maxDailyRewardCredits: 100,
      });

      expect(await claimOn(user, '2031-04-02')).toBe(30);
      const stored = await ctx.client.dailyRewardClaim.findMany({
        where: { authId: user.id },
        orderBy: { claimDate: 'asc' },
      });
      expect(
        stored.map((c) => [c.streakDay, c.rewardCredits, c.grantedCredits]),
      ).toEqual([
        [1, 10, 10],
        [2, 30, 30],
      ]);
    });

    it('shows the caller their state and requires authentication', async () => {
      const user = await createAccount(ctx);
      freezeTime(noon('2031-05-10'));
      await expect(status(user)).resolves.toEqual({
        today: '2031-05-10',
        month: '2031-05',
        claimedToday: false,
        todayClaim: null,
        currentStreakDays: 0,
        nextRewardCredits: 10,
        monthlyCapCredits: 600,
        claimedThisMonthCredits: 0,
        remainingThisMonthCredits: 600,
      });
      const made = dataOf<ClaimView>(await claim(user).expect(201));
      await expect(status(user)).resolves.toMatchObject({
        claimedToday: true,
        todayClaim: made,
        currentStreakDays: 1,
        nextRewardCredits: 20,
        claimedThisMonthCredits: 10,
        remainingThisMonthCredits: 590,
      });
      await as(ctx).get(STATUS).expect(401);
      await as(ctx).post(CLAIM).expect(401);
    });
  });

  describe('the monthly cap of 600 credits', () => {
    it('grants exactly 600 with the defaults (on the 14th day) and refuses further claims that month', async () => {
      const user = await createAccount(ctx);
      const granted: number[] = [];
      for (let day = 1; day <= 20; day += 1) {
        granted.push(
          await claimOn(user, `2031-07-${String(day).padStart(2, '0')}`),
        );
      }

      // 10 + 20 + 30 + 40 + 10 x 50 = 600 after 14 days.
      expect(granted.slice(0, 14)).toEqual([
        10,
        20,
        30,
        40,
        ...Array<number>(10).fill(50),
      ]);
      expect(granted.slice(14)).toEqual(Array<number>(6).fill(0));
      await expect(walletGrantsByMonth(user.id)).resolves.toEqual({
        '2031-07': 600,
      });
      await expect(
        ctx.client.dailyRewardMonthlyTotal.findUniqueOrThrow({
          where: {
            authId_monthStart: {
              authId: user.id,
              monthStart: new Date('2031-07-01'),
            },
          },
        }),
      ).resolves.toMatchObject({ totalCredits: 600 });
      await expect(status(user)).resolves.toMatchObject({
        claimedToday: false,
        nextRewardCredits: 0,
        claimedThisMonthCredits: 600,
        remainingThisMonthCredits: 0,
      });
      // Refused claims write nothing.
      await expect(
        ctx.client.dailyRewardClaim.count({ where: { authId: user.id } }),
      ).resolves.toBe(14);
      await expectConsistentLedger(ctx.client, user.id);
    });

    it('grants only the rest with the claim that reaches the cap, then starts again next month', async () => {
      await setSettings({
        startingRewardCredits: 10,
        dailyIncrementCredits: 20,
        maxDailyRewardCredits: 70,
      });
      const user = await createAccount(ctx);
      const granted: number[] = [];
      for (let day = 1; day <= 12; day += 1) {
        granted.push(
          await claimOn(user, `2031-08-${String(day).padStart(2, '0')}`),
        );
      }

      // 10 + 30 + 50 + 7 x 70 = 580; the 11th day's reward of 70 grants 20.
      expect(granted).toEqual([10, 30, 50, 70, 70, 70, 70, 70, 70, 70, 20, 0]);
      const capped = await ctx.client.dailyRewardClaim.findFirstOrThrow({
        where: { authId: user.id, claimDate: new Date('2031-08-11') },
      });
      expect([capped.rewardCredits, capped.grantedCredits]).toEqual([70, 20]);

      // A new UTC month: the cap starts again (the streak was broken on the 12th).
      expect(await claimOn(user, '2031-09-01')).toBe(10);
      await expect(walletGrantsByMonth(user.id)).resolves.toEqual({
        '2031-08': 600,
        '2031-09': 10,
      });
      await expectConsistentLedger(ctx.client, user.id);
    });

    it('keeps the streak across a month boundary while the cap is counted per month', async () => {
      const user = await createAccount(ctx);
      for (let day = 27; day <= 31; day += 1) {
        await claimOn(user, `2031-10-${day}`);
      }
      freezeTime(noon('2031-11-01'));
      await expect(claim(user).expect(201).then(dataOf)).resolves.toMatchObject(
        {
          streakDay: 6,
          grantedCredits: 50,
        },
      );
      await expect(status(user)).resolves.toMatchObject({
        month: '2031-11',
        claimedThisMonthCredits: 50,
        remainingThisMonthCredits: 550,
      });
    });

    it('uses UTC calendar months, whatever the client time zone', async () => {
      await setSettings({
        startingRewardCredits: 600,
        dailyIncrementCredits: 0,
        maxDailyRewardCredits: 600,
      });
      const user = await createAccount(ctx);
      // 23:30 on 31 December UTC is already 1 January in UTC+1: still December.
      freezeTime(new Date('2031-12-31T23:30:00.000Z'));
      await claim(user).expect(201);
      freezeTime(new Date('2032-01-01T00:10:00.000+01:00')); // 2031-12-31T23:10Z
      expect(messageOf(await claim(user).expect(409))).toBe(ALREADY_CLAIMED);
      freezeTime(new Date('2032-01-01T00:00:00.000Z'));
      await expect(claim(user).expect(201).then(dataOf)).resolves.toMatchObject(
        {
          claimDate: '2032-01-01',
          grantedCredits: 600,
        },
      );
      await expect(walletGrantsByMonth(user.id)).resolves.toEqual({
        '2031-12': 600,
        '2032-01': 600,
      });
    });

    it('grants one claim per day however many requests arrive at once', async () => {
      const user = await createAccount(ctx);
      freezeTime(noon('2032-02-10'));

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => claim(user)),
      );

      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([201, ...Array<number>(9).fill(409)]);
      await expect(
        ctx.client.dailyRewardClaim.count({ where: { authId: user.id } }),
      ).resolves.toBe(1);
      await expect(walletGrantsByMonth(user.id)).resolves.toEqual({
        '2032-02': 10,
      });
      await expectConsistentLedger(ctx.client, user.id);
    });

    it('never exceeds the cap when the claim that reaches it is sent many times at once', async () => {
      await setSettings({
        startingRewardCredits: 200,
        dailyIncrementCredits: 0,
        maxDailyRewardCredits: 250,
      });
      const user = await createAccount(ctx);
      expect(await claimOn(user, '2032-03-01')).toBe(200);
      expect(await claimOn(user, '2032-03-02')).toBe(200);
      freezeTime(noon('2032-03-03'));

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => claim(user)),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      await expect(walletGrantsByMonth(user.id)).resolves.toEqual({
        '2032-03': 600,
      });
      expect(await claimOn(user, '2032-03-04')).toBe(0);
      await expect(walletGrantsByMonth(user.id)).resolves.toEqual({
        '2032-03': 600,
      });
    });

    it('has PostgreSQL refuse daily reward credits beyond 600 in a month from any write path', async () => {
      const user = await createAccount(ctx);
      const insert = (day: string, granted: number) =>
        ctx.client.dailyRewardClaim.create({
          data: {
            authId: user.id,
            claimDate: new Date(`${day}T00:00:00.000Z`),
            monthStart: new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`),
            streakDay: 1,
            rewardCredits: 600,
            grantedCredits: granted,
            claimedAt: new Date(),
          },
        });

      await insert('2032-05-01', 590);
      await expect(insert('2032-05-02', 11)).rejects.toThrow(
        'DailyRewardMonthlyTotal_totalCredits_cap',
      );
      // Deleting or lowering the month's total by hand does not reopen it:
      // every claim recomputes the total from the month's claims.
      await ctx.client.dailyRewardMonthlyTotal.deleteMany({
        where: { authId: user.id },
      });
      await expect(insert('2032-05-02', 11)).rejects.toThrow(
        'DailyRewardMonthlyTotal_totalCredits_cap',
      );
      await insert('2032-05-02', 10);
      await expect(
        ctx.client.dailyRewardClaim.updateMany({
          where: { authId: user.id },
          data: { grantedCredits: 1 },
        }),
      ).rejects.toThrow('cannot be changed');
      await expect(
        ctx.client.dailyRewardMonthlyTotal.update({
          where: {
            authId_monthStart: {
              authId: user.id,
              monthStart: new Date('2032-05-01'),
            },
          },
          data: { totalCredits: 601 },
        }),
      ).rejects.toThrow('DailyRewardMonthlyTotal_totalCredits_cap');

      // The API agrees: nothing is left this month.
      freezeTime(noon('2032-05-03'));
      expect(messageOf(await claim(user).expect(409))).toBe(CAP_REACHED);
    });
  });

  describe('DAILY_REWARD credits outside claims', () => {
    const wallet = () => ctx.get<CreditWalletService>(CreditWalletService);
    const grantDaily = (authId: string, day: string, amount: string) =>
      wallet().grant({
        authId,
        source: 'DAILY_REWARD',
        sourceReference: `daily-reward:${day}`,
        amount,
      });

    it('the wallet refuses DAILY_REWARD credits without a matching claim', async () => {
      const user = await createAccount(ctx);
      expect(await claimOn(user, '2032-08-01')).toBe(10);

      // No claim for that day.
      await expect(grantDaily(user.id, '2032-08-02', '50')).rejects.toThrow(
        'recorded daily reward claim',
      );
      // A claimed day, but another amount than the claim granted.
      await expect(grantDaily(user.id, '2032-08-01', '600')).rejects.toThrow(
        'already granted with a different amount',
      );
      // A reference that names no day.
      await expect(
        wallet().grant({
          authId: user.id,
          source: 'DAILY_REWARD',
          sourceReference: 'bonus-600',
          amount: '600',
        }),
      ).rejects.toThrow('recorded daily reward claim');
      // Repeating the claim's own grant adds nothing.
      await expect(
        grantDaily(user.id, '2032-08-01', '10'),
      ).resolves.toMatchObject({
        replayed: true,
      });

      await expect(walletGrantsByMonth(user.id)).resolves.toEqual({
        '2032-08': 10,
      });
      await expectConsistentLedger(ctx.client, user.id);
    });

    it('keeps the monthly total at 600 even when credits are added outside claims', async () => {
      await setSettings({
        startingRewardCredits: 300,
        dailyIncrementCredits: 0,
        maxDailyRewardCredits: 300,
      });
      const user = await createAccount(ctx);
      expect(await claimOn(user, '2032-09-01')).toBe(300);
      expect(await claimOn(user, '2032-09-02')).toBe(300);

      await expect(grantDaily(user.id, '2032-09-03', '300')).rejects.toThrow(
        'recorded daily reward claim',
      );
      expect(await claimOn(user, '2032-09-03')).toBe(0);
      await expect(walletGrantsByMonth(user.id)).resolves.toEqual({
        '2032-09': 600,
      });
    });

    it('has PostgreSQL refuse DAILY_REWARD allocations without a matching claim from any write path', async () => {
      const user = await createAccount(ctx);
      expect(await claimOn(user, '2032-10-01')).toBe(10);
      const wallet = await ctx.client.creditWallet.findUniqueOrThrow({
        where: { authId: user.id },
      });
      const insert = (reference: string, amount: number) =>
        ctx.client.creditAllocation.create({
          data: {
            walletId: wallet.id,
            authId: user.id,
            source: 'DAILY_REWARD',
            sourceReference: reference,
            amount,
            remaining: amount,
            grantedAt: new Date(),
          },
        });

      await expect(insert('daily-reward:2032-10-02', 600)).rejects.toThrow(
        'require a recorded daily reward claim',
      );
      await expect(insert('manual-bonus', 600)).rejects.toThrow(
        'must reference a claimed day',
      );
      await expect(
        ctx.client.creditAllocation.count({
          where: { authId: user.id, source: 'DAILY_REWARD' },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('persistence', () => {
    it('keeps claims, streaks and the month total across an application restart', async () => {
      const user = await createAccount(ctx);
      expect(await claimOn(user, '2032-06-01')).toBe(10);

      await ctx.close();
      ctx = await bootApplication({ schema });
      await listen(ctx);

      freezeTime(noon('2032-06-01'));
      expect(messageOf(await claim(user).expect(409))).toBe(ALREADY_CLAIMED);
      expect(await claimOn(user, '2032-06-02')).toBe(20);
      await expect(status(user)).resolves.toMatchObject({
        currentStreakDays: 2,
        claimedThisMonthCredits: 30,
      });
    });
  });
});
