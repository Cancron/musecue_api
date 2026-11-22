// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { nextTestIp } from './support/discount-fixtures';
import { describeWithDatabase } from './support/migrated-schema';
import {
  bootReferralApp,
  dataOf,
  referralFlows,
  type ReferralApp,
  type SignedUp,
} from './support/referral-flows';

jest.setTimeout(240_000);

interface Overview {
  code: string;
  referred: boolean;
  referralDiscountPercent: number;
  rewardCreditsPerReferral: number;
  referrals: {
    total: number;
    pending: number;
    rewarded: number;
    qualified: number;
  };
  totalEarnedCredits: string;
}
interface Invitee {
  id: string;
  displayName: string;
  status: string;
  signedUpAt: string;
  qualifiedAt: string | null;
  rewardCredits: number | null;
  rewardedAt: string | null;
}
interface Reward {
  id: string;
  referralId: string;
  displayName: string | null;
  credits: string;
  remainingCredits: string;
  grantedAt: string;
  expiresAt: null;
}

/**
 * The referral APIs through the complete application: a user sees their own
 * code, the people they invited (pending, rewarded or qualified, by a masked
 * name only), their earnings and reward history, and nobody else's.
 */
describeWithDatabase('Referral APIs (PostgreSQL, full stack)', () => {
  let app: ReferralApp;
  let r: ReturnType<typeof referralFlows>;
  let admin: Awaited<ReturnType<ReturnType<typeof referralFlows>['admin']>>;
  let referrer: SignedUp;
  let pendingFriend: SignedUp;
  let rewardedFriend: SignedUp;
  let qualifiedFriend: SignedUp;
  let stranger: SignedUp;
  let strangersFriend: SignedUp;

  const overview = async (account: SignedUp) =>
    dataOf<Overview>(await r.get(account, '/v1/referrals').expect(200));
  const invitees = async (account: SignedUp, query = '') =>
    dataOf<Invitee[]>(
      await r.get(account, `/v1/referrals/invitees${query}`).expect(200),
    );
  const rewards = async (account: SignedUp) =>
    dataOf<Reward[]>(await r.get(account, '/v1/referrals/rewards').expect(200));

  beforeAll(async () => {
    app = await bootReferralApp();
    r = referralFlows(app);
    admin = await r.admin();
    await r.setDiscountSettings(admin, {
      referralDiscountPercent: 10,
      referrerRewardCredits: 0,
    });

    referrer = await r.signUp({ prefix: 'owner' });
    const code = await r.codeOf(referrer);
    // Qualified while the reward was off.
    qualifiedFriend = await r.signUp({ prefix: 'quinn', referralCode: code });
    await r.buyPro(qualifiedFriend);
    await r.setDiscountSettings(admin, { referrerRewardCredits: 120 });
    // Rewarded.
    rewardedFriend = await r.signUp({ prefix: 'rita', referralCode: code });
    await r.buyPro(rewardedFriend);
    // Pending.
    pendingFriend = await r.signUp({ prefix: 'pat', referralCode: code });

    stranger = await r.signUp({ prefix: 'stranger' });
    strangersFriend = await r.signUp({
      prefix: 'sam',
      referralCode: await r.codeOf(stranger),
    });
  });

  afterAll(async () => {
    await app?.ctx.close();
  });

  it('GET /v1/referrals shows the caller’s code, referral counts and earnings', async () => {
    await expect(overview(referrer)).resolves.toEqual({
      code: await r.codeOf(referrer),
      referred: false,
      referralDiscountPercent: 0,
      rewardCreditsPerReferral: 120,
      referrals: {
        total: 3,
        pending: 1,
        rewarded: 1,
        qualified: 1,
        underReview: 0,
        rejected: 0,
      },
      milestones: { paidReferrals: 2, reached: [], next: null },
      totalEarnedCredits: '120',
    });
    // The invited user sees that they were referred and the discount they
    // get before their first purchase; after it, none.
    await expect(overview(pendingFriend)).resolves.toMatchObject({
      referred: true,
      referralDiscountPercent: 10,
      referrals: { total: 0 },
    });
    await expect(overview(rewardedFriend)).resolves.toMatchObject({
      referred: true,
      referralDiscountPercent: 0,
    });
  });

  it('GET /v1/referrals/invitees lists pending and paid referrals by masked name, filterable by status', async () => {
    const all = await invitees(referrer);

    expect(all.map((i) => [i.displayName, i.status])).toEqual([
      ['pa***', 'PENDING'],
      ['ri***', 'REWARDED'],
      ['qu***', 'QUALIFIED'],
    ]);
    expect(all[0]).toMatchObject({
      qualifiedAt: null,
      rewardCredits: null,
      rewardedAt: null,
    });
    expect(all[1]).toMatchObject({
      rewardCredits: 120,
      qualifiedAt: expect.any(String) as unknown,
      rewardedAt: expect.any(String) as unknown,
    });
    expect(all[2]).toMatchObject({
      rewardCredits: null,
      qualifiedAt: expect.any(String) as unknown,
    });

    await expect(invitees(referrer, '?status=PENDING')).resolves.toEqual([
      all[0],
    ]);
    await expect(invitees(referrer, '?status=REWARDED')).resolves.toEqual([
      all[1],
    ]);
    await r.get(referrer, '/v1/referrals/invitees?status=PAID').expect(400);
  });

  it('GET /v1/referrals/rewards lists the rewards received, with credits that never expire', async () => {
    const history = await rewards(referrer);
    const rewardedReferral = await r.referralOf(rewardedFriend.id);

    expect(history).toEqual([
      {
        id: expect.any(String) as unknown,
        kind: 'REFERRAL',
        referralId: rewardedReferral!.id,
        milestoneReferralCount: null,
        displayName: 'ri***',
        credits: '120',
        remainingCredits: '120',
        grantedAt: rewardedReferral!.rewardedAt!.toISOString(),
        expiresAt: null,
      },
    ]);
    await expect(rewards(pendingFriend)).resolves.toEqual([]);
  });

  it('shows every user only their own referral data, never emails or user ids', async () => {
    const mine = JSON.stringify([
      await overview(referrer),
      await invitees(referrer),
      await rewards(referrer),
    ]);
    for (const friend of [pendingFriend, rewardedFriend, qualifiedFriend]) {
      expect(mine).not.toContain(friend.email);
      expect(mine).not.toContain(friend.id);
    }

    // Another user sees only their own invitee and nothing of the referrer.
    const theirs = await invitees(stranger);
    expect(theirs.map((i) => i.displayName)).toEqual(['sa***']);
    await expect(overview(stranger)).resolves.toMatchObject({
      referrals: { total: 1, pending: 1, rewarded: 0, qualified: 0 },
      totalEarnedCredits: '0',
    });
    await expect(rewards(stranger)).resolves.toEqual([]);
    const strangers = JSON.stringify([await overview(stranger), theirs]);
    expect(strangers).not.toContain(await r.codeOf(referrer));
    expect(strangers).not.toContain(strangersFriend.email);

    // The invited user learns nothing about the referrer.
    const invited = JSON.stringify(await overview(pendingFriend));
    expect(invited).not.toContain(referrer.email);
    expect(invited).not.toContain(referrer.id);

    // No route takes another user's id, and there is no way to pass one.
    await r
      .get(stranger, `/v1/referrals/invitees?userId=${referrer.id}`)
      .expect(400);
    await r.get(stranger, `/v1/referrals?userId=${referrer.id}`).expect(400);
    await r
      .get(stranger, `/v1/referrals/rewards?userId=${referrer.id}`)
      .expect(400);
    const referralId = (await r.referralOf(pendingFriend.id))!.id;
    await r.get(stranger, `/v1/referrals/invitees/${referralId}`).expect(404);
  });

  it('requires authentication for every referral route', async () => {
    for (const path of [
      '/v1/referrals',
      '/v1/referrals/invitees',
      '/v1/referrals/rewards',
    ]) {
      await r.http().get(path).set('X-Forwarded-For', nextTestIp()).expect(401);
      await r
        .http()
        .get(path)
        .set('X-Forwarded-For', nextTestIp())
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
    }
  });

  it('keeps the earnings after an invited user’s account is deleted', async () => {
    await app.ctx.client.authUser.delete({ where: { id: rewardedFriend.id } });

    expect((await invitees(referrer)).map((i) => i.displayName)).toEqual([
      'pa***',
      'qu***',
    ]);
    await expect(rewards(referrer)).resolves.toEqual([
      expect.objectContaining({ credits: '120', displayName: null }),
    ]);
    await expect(overview(referrer)).resolves.toMatchObject({
      referrals: { total: 2, pending: 1, rewarded: 0, qualified: 1 },
      totalEarnedCredits: '120',
    });
  });
});
