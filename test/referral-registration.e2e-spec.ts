// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { createHash } from 'node:crypto';
import {
  bootReferralApp,
  dataOf,
  messageOf,
  referralFlows,
  type ReferralApp,
} from './support/referral-flows';
import { nextTestIp } from './support/discount-fixtures';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(180_000);

process.env.GOOGLE_CLIENT_ID = 'referral-e2e.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'referral-e2e-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:5000/auth/google/callback';

interface Overview {
  code: string;
  referred: boolean;
  referralDiscountPercent: number;
  referrals: {
    total: number;
    pending: number;
    rewarded: number;
    qualified: number;
  };
  totalEarnedCredits: string;
}

/**
 * Referral registration through the complete application: every user's own
 * code, referrals recorded only when signing up (POST /auth with the code,
 * in the transaction that creates the account), and every refused case
 * (invalid codes, self-referral, duplicate and retrospective referrals)
 * leaving nothing behind. Signing up, verifying the email and activating
 * the trial never reward the referrer.
 */
describeWithDatabase('Referral registration (PostgreSQL, full stack)', () => {
  let app: ReferralApp;
  let r: ReturnType<typeof referralFlows>;

  const overview = async (account: {
    id: string;
    role: 'USER' | 'ADMIN' | 'MODERATOR' | 'SUPERADMIN';
  }) => dataOf<Overview>(await r.get(account, '/v1/referrals').expect(200));
  /** Everything a refused registration must leave untouched. */
  const registrationState = async (email: string) => ({
    accounts: await app.ctx.client.authUser.count({ where: { email } }),
    referrals: await app.ctx.client.referral.count(),
    emails: app.ctx.emails.sent.filter((item) => item.to === email).length,
  });

  beforeAll(async () => {
    app = await bootReferralApp();
    r = referralFlows(app);
    const admin = await r.admin();
    await r.setDiscountSettings(admin, {
      referralDiscountPercent: 15,
      referrerRewardCredits: 100,
    });
  });

  afterAll(async () => {
    await app?.ctx.close();
  });

  it('gives every user an individual, stable referral code', async () => {
    const first = await r.signUp();
    const second = await r.signUp();
    const code = await r.codeOf(first);

    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    await expect(r.codeOf(first)).resolves.toBe(code);
    await expect(r.codeOf(second)).resolves.not.toBe(code);
    await expect(overview(first)).resolves.toMatchObject({
      referred: false,
      referralDiscountPercent: 0,
      referrals: { total: 0, pending: 0, rewarded: 0, qualified: 0 },
      totalEarnedCredits: '0',
    });
  });

  it('records the referral with the new account and gives the referred user the referral discount', async () => {
    const referrer = await r.signUp();
    const code = await r.codeOf(referrer);

    const friend = await r.signUp({ referralCode: ` ${code.toLowerCase()} ` });

    const referral = await r.referralOf(friend.id);
    expect(referral).toMatchObject({
      referrerAuthId: referrer.id,
      referralCode: code,
      status: 'PENDING',
      qualifiedAt: null,
      rewardCredits: null,
    });
    // Only a hash of the canonical email is stored with the referral.
    expect(referral?.canonicalEmailHash).toBe(
      createHash('sha256').update(friend.email.toLowerCase()).digest('hex'),
    );
    await expect(overview(friend)).resolves.toMatchObject({
      referred: true,
      referralDiscountPercent: 15,
    });
    await expect(overview(referrer)).resolves.toMatchObject({
      referrals: { total: 1, pending: 1, rewarded: 0, qualified: 0 },
    });

    const checkout = await r.checkout(friend);
    expect(checkout).toMatchObject({
      discount: { source: 'REFERRAL', amountOffCents: 285 },
      amountDueCents: 1615,
    });
  });

  describe('refused referrals create nothing', () => {
    it.each([
      ['an unknown code', () => 'NOSUCHCODE', 'Invalid referral code'],
      ['a malformed code', () => 'bad code!', 'Invalid referral code'],
      [
        'the code of a deleted account',
        async () => {
          const gone = await r.signUp();
          const code = await r.codeOf(gone);
          await app.ctx.client.authUser.update({
            where: { id: gone.id },
            data: { status: 'DELETED', deletedAt: new Date() },
          });
          return code;
        },
        'Invalid referral code',
      ],
      [
        'the code of a blocked account',
        async () => {
          const blocked = await r.signUp();
          const code = await r.codeOf(blocked);
          await app.ctx.client.authUser.update({
            where: { id: blocked.id },
            data: { status: 'BLOCKED' },
          });
          return code;
        },
        'Invalid referral code',
      ],
    ])('refuses %s with 400', async (_case, prepare, message) => {
      const code = await prepare();
      const identity = r.newIdentity();
      const before = await registrationState(identity.email);

      const response = await r
        .register({ ...identity, referralCode: code })
        .expect(400);

      expect(messageOf(response)).toBe(message);
      await expect(registrationState(identity.email)).resolves.toEqual(before);
    });

    it('refuses a code that is too long or not a string before anything else', async () => {
      for (const referralCode of ['X'.repeat(33), 12345678, null, '']) {
        const identity = r.newIdentity();
        await r.register({ ...identity, referralCode }).expect(400);
        await expect(
          app.ctx.client.authUser.count({ where: { email: identity.email } }),
        ).resolves.toBe(0);
      }
    });

    it('refuses a self-referral, including another address of the same mailbox', async () => {
      const alice = await r.signUp({ email: `a.lice.${Date.now()}@gmail.com` });
      const code = await r.codeOf(alice);
      const sameMailbox = `${alice.email.split('@')[0].replace(/\./g, '')}+second@googlemail.com`;
      const before = await registrationState(sameMailbox);

      const response = await r
        .register({
          ...r.newIdentity(),
          email: sameMailbox,
          referralCode: code,
        })
        .expect(400);

      expect(messageOf(response)).toBe('You cannot use your own referral code');
      await expect(registrationState(sameMailbox)).resolves.toEqual(before);
    });

    it('refuses a second referral of the same person, also under another address', async () => {
      const referrer = await r.signUp();
      const other = await r.signUp();
      const stamp = Date.now();
      await r.signUp({
        email: `bob${stamp}+one@example.com`,
        referralCode: await r.codeOf(referrer),
      });
      const second = `bob${stamp}+two@example.com`;
      const before = await registrationState(second);

      const response = await r
        .register({
          ...r.newIdentity(),
          email: second,
          referralCode: await r.codeOf(other),
        })
        .expect(409);

      expect(messageOf(response)).toBe(
        'A referral was already registered for this email address',
      );
      await expect(registrationState(second)).resolves.toEqual(before);
    });

    it('registers one referral when the same person signs up concurrently under several addresses', async () => {
      const referrer = await r.signUp();
      const code = await r.codeOf(referrer);
      const stamp = Date.now();
      const emails = Array.from(
        { length: 6 },
        (_, i) => `carol${stamp}+${i}@example.com`,
      );

      const responses = await Promise.all(
        emails.map((email) =>
          r.register({ ...r.newIdentity(), email, referralCode: code }),
        ),
      );

      expect(responses.filter((res) => res.status === 201)).toHaveLength(1);
      expect(responses.every((res) => [201, 409].includes(res.status))).toBe(
        true,
      );
      await expect(
        app.ctx.client.authUser.count({ where: { email: { in: emails } } }),
      ).resolves.toBe(1);
      await expect(
        app.ctx.client.referral.count({
          where: { referrerAuthId: referrer.id },
        }),
      ).resolves.toBe(1);
    });

    it('refuses retrospective referrals of existing accounts', async () => {
      const referrer = await r.signUp();
      const code = await r.codeOf(referrer);
      const existing = await r.signUp();
      const referralsBefore = await app.ctx.client.referral.count();

      const applied = await r
        .post(existing, '/v1/referrals/apply', { code })
        .expect(409);
      expect(messageOf(applied)).toBe(
        'Referral codes can only be used when signing up',
      );
      // Registering the same email again, now with a code, is refused too.
      const again = await r
        .register({
          username: `again_${Date.now() % 1e8}`,
          email: existing.email,
          password: existing.password,
          referralCode: code,
        })
        .expect(409);
      expect(messageOf(again)).toBe('Email already exists!');

      await expect(app.ctx.client.referral.count()).resolves.toBe(
        referralsBefore,
      );
      await expect(r.referralOf(existing.id)).resolves.toBeNull();
      await expect(overview(existing)).resolves.toMatchObject({
        referred: false,
      });
    });
  });

  it('never rewards the referrer for the signup, the email verification or the trial', async () => {
    const referrer = await r.signUp();
    const friend = await r.signUp({ referralCode: await r.codeOf(referrer) });
    await r.post(friend, '/v1/subscription/trial').expect(201);

    await expect(r.rewardAllocations(referrer.id)).resolves.toEqual([]);
    await expect(r.referralOf(friend.id)).resolves.toMatchObject({
      status: 'PENDING',
      rewardCredits: null,
    });
    await expect(overview(referrer)).resolves.toMatchObject({
      referrals: { total: 1, pending: 1 },
      totalEarnedCredits: '0',
    });
  });

  it('checks a Google sign-up referral code before the sign-in starts', async () => {
    const referrer = await r.signUp();
    const code = await r.codeOf(referrer);
    const google = (query: string) =>
      r.http().get(`/auth/google${query}`).set('X-Forwarded-For', nextTestIp());

    expect(
      messageOf(await google('?referralCode=NOSUCHCODE').expect(400)),
    ).toBe('Invalid referral code');
    const started = dataOf<{ url: string; state: string }>(
      await google(`?referralCode=${code.toLowerCase()}`).expect(200),
    );
    expect(started.url).toContain('accounts.google.com');
  });

  it('has PostgreSQL refuse referrals after a paid purchase, self-referrals and changed referrals', async () => {
    const referrer = await r.signUp();
    const friend = await r.signUp({ referralCode: await r.codeOf(referrer) });
    const referral = (await r.referralOf(friend.id))!;

    await expect(
      app.ctx.client.referral.update({
        where: { id: referral.id },
        data: { referrerAuthId: friend.id },
      }),
    ).rejects.toThrow();
    await expect(
      app.ctx.client.referral.update({
        where: { id: referral.id },
        data: { referralCode: 'OTHER123' },
      }),
    ).rejects.toThrow('A referral cannot be changed');
    await expect(
      app.ctx.client.referral.create({
        data: { authId: referrer.id, referrerAuthId: referrer.id },
      }),
    ).rejects.toThrow('Referral_not_self');

    // A user who already paid can never be referred.
    const buyer = await r.signUp();
    await r.buyPro(buyer);
    await expect(
      app.ctx.client.referral.create({
        data: { authId: buyer.id, referrerAuthId: referrer.id },
      }),
    ).rejects.toThrow('A referral cannot be recorded after a paid purchase');
  });
});
