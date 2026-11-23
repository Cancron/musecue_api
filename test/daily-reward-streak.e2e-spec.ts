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

jest.setTimeout(240_000);

const CLAIM = '/v1/daily-rewards/claim';
const STATUS = '/v1/daily-rewards';
const SETTINGS = '/v1/admin/daily-reward-settings';

interface ClaimView {
  claimDate: string;
  streakDay: number;
  rewardCredits: number;
  grantedCredits: number;
  limitedByMonthlyCap: boolean;
}
interface StatusView {
  currentStreakDays: number;
  longestStreakDays: number;
  canClaimNow: boolean;
  nextClaim: {
    date: string;
    streakDay: number;
    rewardCredits: number;
    grantedCredits: number;
  };
  claimedThisMonthCredits: number;
  remainingThisMonthCredits: number;
  creditBalance: { available: string };
}

/** Noon UTC of `day` (YYYY-MM-DD). */
const noon = (day: string) => new Date(`${day}T12:00:00.000Z`);
/** `count` consecutive UTC days from `first` (YYYY-MM-DD). */
const days = (first: string, count: number) =>
  Array.from({ length: count }, (_, i) =>
    new Date(new Date(`${first}T00:00:00.000Z`).getTime() + i * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );

/**
 * Daily reward streaks through the complete application and PostgreSQL,
 * with the clock moved by freezeTime: rewards rise with consecutive UTC days
 * (10, 20, 30, 40, then 50), a missed day starts again without taking back
 * what was received, partial and zero-credit claims (monthly cap of 600)
 * keep the streak, a new month renews the cap but not the streak, and
 * settings changes apply to later claims only.
 */
describeWithDatabase('Daily reward streaks (PostgreSQL, full stack)', () => {
  let schema: string;
  let ctx: TestApplication;
  let admin: TestAccount;

  const claim = (account: TestAccount) => as(ctx, account).post(CLAIM);
  const status = async (account: TestAccount) =>
    dataOf<StatusView>(await as(ctx, account).get(STATUS).expect(200));
  const claimOn = async (account: TestAccount, day: string) => {
    freezeTime(noon(day));
    return dataOf<ClaimView>(await claim(account).expect(201));
  };
  const claimDays = async (account: TestAccount, list: string[]) => {
    const made: ClaimView[] = [];
    for (const day of list) made.push(await claimOn(account, day));
    return made;
  };
  const granted = (claims: ClaimView[]) => claims.map((c) => c.grantedCredits);
  const dailyCredits = async (authId: string) =>
    (
      await ctx.client.creditAllocation.findMany({
        where: { authId, source: 'DAILY_REWARD' },
      })
    ).reduce((sum, a) => sum + Number(a.amount.toFixed()), 0);
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

  it('starts at 10 and rises by 10 per consecutive UTC day up to 50, then stays at 50', async () => {
    const user = await createAccount(ctx);
    const claims = await claimDays(user, days('2034-01-01', 8));

    expect(claims.map((c) => [c.streakDay, c.grantedCredits])).toEqual([
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
      [5, 50],
      [6, 50],
      [7, 50],
      [8, 50],
    ]);
    freezeTime(noon('2034-01-08'));
    await expect(status(user)).resolves.toMatchObject({
      currentStreakDays: 8,
      longestStreakDays: 8,
      canClaimNow: false,
      nextClaim: { date: '2034-01-09', streakDay: 9, rewardCredits: 50 },
    });
    // The streak counts UTC days: just before and after midnight UTC are
    // two consecutive days.
    freezeTime(new Date('2034-01-09T23:59:59.000Z'));
    await claim(user).expect(201);
    freezeTime(new Date('2034-01-10T00:00:01.000Z'));
    await expect(claim(user).expect(201).then(dataOf)).resolves.toMatchObject({
      claimDate: '2034-01-10',
      streakDay: 10,
    });
  });

  it('starts again at 10 after a missed day, keeping every credit already received', async () => {
    const user = await createAccount(ctx);
    await claimDays(user, days('2034-02-01', 4)); // 10 + 20 + 30 + 40
    expect(await dailyCredits(user.id)).toBe(100);

    // 2034-02-05 is missed.
    freezeTime(noon('2034-02-06'));
    await expect(status(user)).resolves.toMatchObject({
      currentStreakDays: 0,
      longestStreakDays: 4,
      canClaimNow: true,
      nextClaim: { date: '2034-02-06', streakDay: 1, rewardCredits: 10 },
      creditBalance: { available: '100' },
    });
    const restarted = await claimOn(user, '2034-02-06');
    expect(restarted).toMatchObject({ streakDay: 1, grantedCredits: 10 });
    expect(await claimOn(user, '2034-02-07')).toMatchObject({
      streakDay: 2,
      grantedCredits: 20,
    });
    // Nothing was taken back.
    expect(await dailyCredits(user.id)).toBe(130);
    await expect(status(user)).resolves.toMatchObject({
      currentStreakDays: 2,
      longestStreakDays: 4,
      creditBalance: { available: '130' },
    });
    await expectConsistentLedger(ctx.client, user.id);
  });

  it('keeps the streak with partial and zero-credit claims; a new month renews the cap, not the streak', async () => {
    await setSettings({
      startingRewardCredits: 70,
      dailyIncrementCredits: 0,
      maxDailyRewardCredits: 70,
    });
    const user = await createAccount(ctx);
    // 8 x 70 = 560 from the 21st; the 29th grants the remaining 40 (partial),
    // the 30th grants 0: both keep the streak.
    const september = await claimDays(user, days('2034-09-21', 10));
    expect(granted(september)).toEqual([70, 70, 70, 70, 70, 70, 70, 70, 40, 0]);
    expect(september.slice(8)).toMatchObject([
      { streakDay: 9, rewardCredits: 70, limitedByMonthlyCap: true },
      { streakDay: 10, rewardCredits: 70, limitedByMonthlyCap: true },
    ]);
    await expect(status(user)).resolves.toMatchObject({
      currentStreakDays: 10,
      claimedThisMonthCredits: 600,
      remainingThisMonthCredits: 0,
      // Tomorrow is in October: a new cap.
      nextClaim: { date: '2034-10-01', streakDay: 11, grantedCredits: 70 },
    });

    const october = await claimOn(user, '2034-10-01');
    expect(october).toMatchObject({
      streakDay: 11,
      grantedCredits: 70,
      limitedByMonthlyCap: false,
    });
    await expect(status(user)).resolves.toMatchObject({
      currentStreakDays: 11,
      claimedThisMonthCredits: 70,
      remainingThisMonthCredits: 530,
    });
    expect(await dailyCredits(user.id)).toBe(670);
  });

  it('keeps a long default streak through a capped month into the next month at the maximum reward', async () => {
    const user = await createAccount(ctx);
    const july = await claimDays(user, days('2035-07-01', 31));
    // 10 + 20 + 30 + 40 + 10 x 50 = 600 on the 14th, then 0 a day.
    expect(granted(july).reduce((a, b) => a + b, 0)).toBe(600);
    expect(granted(july).slice(14)).toEqual(Array<number>(17).fill(0));
    expect(july[30].streakDay).toBe(31);

    // Spending the credits does not free the cap: it counts what was granted.
    await ctx.get<CreditWalletService>(CreditWalletService).debit({
      authId: user.id,
      amount: '600',
      idempotencyKey: 'spend-july-daily-rewards',
    });
    await expect(status(user)).resolves.toMatchObject({
      claimedThisMonthCredits: 600,
      remainingThisMonthCredits: 0,
      creditBalance: { available: '0' },
      nextClaim: { date: '2035-08-01', streakDay: 32, grantedCredits: 50 },
    });

    expect(await claimOn(user, '2035-08-01')).toMatchObject({
      streakDay: 32,
      rewardCredits: 50,
      grantedCredits: 50,
    });
    await expect(status(user)).resolves.toMatchObject({
      currentStreakDays: 32,
      longestStreakDays: 32,
      claimedThisMonthCredits: 50,
    });
  });

  it('ends the streak with a missed day even after zero-credit claims', async () => {
    await setSettings({
      startingRewardCredits: 300,
      dailyIncrementCredits: 0,
      maxDailyRewardCredits: 300,
    });
    const user = await createAccount(ctx);
    const claims = await claimDays(user, days('2034-11-01', 3));
    expect(claims.map((c) => [c.streakDay, c.grantedCredits])).toEqual([
      [1, 300],
      [2, 300],
      [3, 0],
    ]);
    // 2034-11-04 missed.
    expect(await claimOn(user, '2034-11-05')).toMatchObject({
      streakDay: 1,
      grantedCredits: 0,
    });
  });

  it('applies settings changes to later claims only, continuing the streak', async () => {
    const user = await createAccount(ctx);
    await claimDays(user, days('2034-12-01', 3)); // 10, 20, 30

    await setSettings({
      startingRewardCredits: 5,
      dailyIncrementCredits: 5,
      maxDailyRewardCredits: 15,
    });
    freezeTime(noon('2034-12-03'));
    await expect(status(user)).resolves.toMatchObject({
      nextClaim: { streakDay: 4, rewardCredits: 15 },
    });
    expect(await claimOn(user, '2034-12-04')).toMatchObject({
      streakDay: 4,
      rewardCredits: 15,
      grantedCredits: 15,
    });
    await setSettings({
      startingRewardCredits: 100,
      dailyIncrementCredits: 100,
      maxDailyRewardCredits: 600,
    });
    expect(await claimOn(user, '2034-12-05')).toMatchObject({
      streakDay: 5,
      rewardCredits: 500,
      grantedCredits: 500,
    });

    // Earlier claims keep what they granted.
    const stored = await ctx.client.dailyRewardClaim.findMany({
      where: { authId: user.id },
      orderBy: { claimDate: 'asc' },
    });
    expect(
      stored.map((c) => [c.streakDay, c.rewardCredits, c.grantedCredits]),
    ).toEqual([
      [1, 10, 10],
      [2, 20, 20],
      [3, 30, 30],
      [4, 15, 15],
      [5, 500, 500],
    ]);
    expect(await dailyCredits(user.id)).toBe(575);
  });

  it('records one claim with the right streak day however many requests arrive at once', async () => {
    const user = await createAccount(ctx);
    const other = await createAccount(ctx);
    await claimDays(user, days('2035-01-01', 2));
    freezeTime(noon('2035-01-03'));

    const responses = await Promise.all([
      ...Array.from({ length: 12 }, () => claim(user)),
      ...Array.from({ length: 4 }, () => claim(other)),
    ]);
    const mine = responses.slice(0, 12).map((r) => r.status);
    expect(mine.filter((code) => code === 201)).toHaveLength(1);
    expect(mine.filter((code) => code === 409)).toHaveLength(11);
    expect(responses.slice(12).filter((r) => r.status === 201)).toHaveLength(1);

    const stored = await ctx.client.dailyRewardClaim.findMany({
      where: { authId: user.id },
      orderBy: { claimDate: 'asc' },
    });
    expect(stored.map((c) => c.streakDay)).toEqual([1, 2, 3]);
    expect(await dailyCredits(user.id)).toBe(60);
    expect(await dailyCredits(other.id)).toBe(10);
    await expectConsistentLedger(ctx.client, user.id);
  });

  it('has PostgreSQL refuse claims that break the streak rules from any write path', async () => {
    const user = await createAccount(ctx);
    await claimDays(user, days('2035-03-01', 2));
    const insert = (
      day: string,
      data: Partial<{
        streakDay: number;
        rewardCredits: number;
        grantedCredits: number;
        claimedAt: Date;
      }> = {},
    ) =>
      ctx.client.dailyRewardClaim.create({
        data: {
          authId: user.id,
          claimDate: new Date(`${day}T00:00:00.000Z`),
          monthStart: new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`),
          streakDay: 1,
          rewardCredits: 10,
          grantedCredits: 10,
          claimedAt: new Date(`${day}T09:00:00.000Z`),
          ...data,
        },
      });

    // A past day (before the last claimed day), or the same day again.
    await expect(insert('2035-02-27')).rejects.toThrow(
      'only be claimed for a day after the last claimed day',
    );
    // The streak day must follow the previous day's claim.
    await expect(insert('2035-03-03', { streakDay: 7 })).rejects.toThrow(
      "must follow the previous day's claim",
    );
    await expect(insert('2035-03-05', { streakDay: 2 })).rejects.toThrow(
      "must follow the previous day's claim",
    );
    // The claim is for the UTC day it is made.
    await expect(
      insert('2035-03-03', {
        streakDay: 3,
        claimedAt: new Date('2035-03-04T09:00:00.000Z'),
      }),
    ).rejects.toThrow('DailyRewardClaim_claimDate_is_claim_day');
    // Granted credits between 0 and the reward.
    await expect(
      insert('2035-03-03', { streakDay: 3, grantedCredits: 11 }),
    ).rejects.toThrow('DailyRewardClaim_grantedCredits_range');
    await expect(
      insert('2035-03-03', { streakDay: 3, grantedCredits: -1 }),
    ).rejects.toThrow('DailyRewardClaim_grantedCredits_range');

    await expect(
      ctx.client.dailyRewardClaim.count({ where: { authId: user.id } }),
    ).resolves.toBe(2);
    // A zero-credit claim continuing the streak is accepted.
    await insert('2035-03-03', { streakDay: 3, grantedCredits: 0 });
  });

  it('keeps the streak across an application restart', async () => {
    const user = await createAccount(ctx);
    await claimDays(user, days('2035-05-01', 3));

    await ctx.close();
    ctx = await bootApplication({ schema });
    await listen(ctx);

    expect(await claimOn(user, '2035-05-04')).toMatchObject({
      streakDay: 4,
      grantedCredits: 40,
    });
    await expect(status(user)).resolves.toMatchObject({
      currentStreakDays: 4,
      claimedThisMonthCredits: 100,
    });
  });
});
