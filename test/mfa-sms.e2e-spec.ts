// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import { totpCode } from '../src/auth/mfa/mfa-totp';
import { FakeSmsProvider } from './support/fake-sms-provider';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  eventually,
  type TestApplication,
} from './support/infrastructure-flows';
import {
  dataOf,
  lazyRequest,
  messageOf,
  MfaTestKit,
  MIN,
  SECOND,
  type TestUser,
  wrongCode,
} from './support/mfa-e2e';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(120_000);

const HEADER = 'X-Step-Up-Token';

interface ChallengeView {
  mfaRequired: boolean;
  challengeToken: string;
  expiresAt: string;
  methods: string[];
  smsPhoneNumber?: string;
}

interface SentView {
  sent: true;
  phoneNumber: string;
  expiresAt: string;
  deliveriesRemaining: number;
}

interface SmsStatusView {
  available: boolean;
  eligible: boolean;
  enabled: boolean;
  phoneNumber: string | null;
  verifiedAt: string | null;
  pending: { phoneNumber: string; codeExpiresAt: string | null } | null;
  deliveriesRemaining: number;
  attemptsRemaining: number;
}

interface SmsUser extends TestUser {
  /** The verified number (E.164). */
  phone: string;
  recoveryCodes: string[];
}

/**
 * Optional SMS sign-in verification through the real endpoints of the
 * whole application on a temporary, freshly migrated PostgreSQL schema,
 * with the SMS provider mocked (FakeSmsProvider: nothing is sent) and
 * emails captured.
 *
 * Users with authenticator MFA add a phone number and verify it with a code
 * sent to it; at sign-in, the MFA challenge can then send a six-digit code
 * by SMS and be completed with it. Codes are random, stored only as HMACs
 * in PostgreSQL, expire after five minutes and work once; at most three
 * are sent and five checked per user within 15 minutes.
 */
describeWithDatabase('MFA: SMS sign-in verification (e2e)', () => {
  const sms = new FakeSmsProvider();
  let ctx: TestApplication;
  let kit: MfaTestKit;
  let phoneCounter = 0;

  beforeAll(async () => {
    ctx = await bootApplication({ sms });
    kit = new MfaTestKit(ctx, '198.31');
    freezeTime(kit.clock);
    kit.nextStepStart();
  });

  afterAll(async () => {
    jest.useRealTimers();
    await ctx?.close();
  });

  // Far apart: the 15-minute limits and tokens of other tests never matter.
  beforeEach(() => kit.nextStepStart(60 * MIN));

  const http = () => kit.http();

  /** A number nobody else in this suite uses (E.164). */
  const newPhone = () => `+1415555${String(1000 + ++phoneCounter)}`;

  /** A fresh authenticator code (the next 30-second step, never used). */
  const freshCode = (user: TestUser) => {
    kit.nextStepStart();
    return totpCode(user.totpSecret as string, kit.clock);
  };

  const smsStatus = async (user: TestUser) =>
    dataOf<SmsStatusView>(
      await http().get('/auth/mfa/sms').set(kit.as(user)).expect(200),
    );

  /** POST /auth/mfa/sms/phone with an MFA_SMS_PHONE approval. */
  const startPhone = (user: TestUser, phoneNumber: string) =>
    lazyRequest(async () => ({
      test: http()
        .post('/auth/mfa/sms/phone')
        .set(kit.as(user))
        .set(HEADER, await kit.approve(user, 'MFA_SMS_PHONE'))
        .send({ phoneNumber }),
    }));

  /** POST /auth/mfa/sms/phone/confirm with an MFA_SMS_PHONE approval. */
  const confirmPhone = (user: TestUser, code: string) =>
    lazyRequest(async () => ({
      test: http()
        .post('/auth/mfa/sms/phone/confirm')
        .set(kit.as(user))
        .set(HEADER, await kit.approve(user, 'MFA_SMS_PHONE'))
        .send({ code }),
    }));

  /** A user with authenticator MFA (through the API). */
  async function mfaUser() {
    const user = await kit.createUser();
    const { recoveryCodes } = await kit.enableMfa(user);
    return { user, recoveryCodes };
  }

  /**
   * A user with authenticator MFA and a verified number, 16 minutes later
   * (so the delivery used for the verification no longer counts), signed
   * in again.
   */
  async function smsUser(): Promise<SmsUser> {
    const { user, recoveryCodes } = await mfaUser();
    const phone = newPhone();
    await startPhone(user, phone).expect(201);
    await confirmPhone(user, sms.lastCode(phone)).expect(200);
    kit.advance(16 * MIN);
    await kit.signIn(user);
    return { ...user, phone, recoveryCodes };
  }

  /** Password sign-in that must end in an MFA challenge. */
  async function challengeOf(user: TestUser): Promise<ChallengeView> {
    const challenge = dataOf<ChallengeView>(await kit.login(user).expect(201));
    expect(challenge.mfaRequired).toBe(true);
    return challenge;
  }

  /** POST /auth/login/mfa/sms (raw response). */
  const sendCode = (user: TestUser, challengeToken: string) =>
    http()
      .post('/auth/login/mfa/sms')
      .set('X-Forwarded-For', user.ip)
      .send({ challengeToken });

  /** POST /auth/login/mfa (raw response). */
  const complete = (user: TestUser, body: Record<string, unknown>) =>
    http().post('/auth/login/mfa').set('X-Forwarded-For', user.ip).send(body);

  const codesOf = (user: TestUser) =>
    ctx.client.mfaSmsCode.findMany({
      where: { authId: user.id },
      orderBy: { createdAt: 'asc' },
    });

  describe('adding and verifying a phone number', () => {
    it('sends a code to the number, stores it hashed and the number encrypted, and verifies it', async () => {
      const { user } = await mfaUser();
      const phone = newPhone();
      const typed = `${phone.slice(0, 2)} (${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;

      const started = await startPhone(user, typed).expect(201);

      expect(started.headers['cache-control']).toBe('no-store');
      expect(dataOf(started)).toEqual({
        status: 'PENDING',
        phoneNumber: `••••••••${phone.slice(-2)}`,
        replaces: null,
        codeExpiresAt: new Date(kit.clock.getTime() + 5 * MIN).toISOString(),
        deliveriesRemaining: 2,
      });
      // Sent to the normalized number, with a six-digit code.
      const [message] = sms.to(phone);
      expect(message.body).toMatch(
        /^Your MuseCue phone verification code is \d{6}\. It expires in 5 minutes\./,
      );
      // PostgreSQL: the number encrypted, the code only as an HMAC.
      const [row] = await ctx.client.mfaSmsPhone.findMany({
        where: { authId: user.id },
      });
      expect(row).toMatchObject({
        status: 'PENDING',
        phoneHint: phone.slice(-2),
        verifiedAt: null,
      });
      expect(row.phoneNumber).toMatch(/^mfa2\./);
      expect(row.phoneNumber).not.toContain(phone.slice(2));
      const [stored] = await codesOf(user);
      expect(stored).toMatchObject({
        purpose: 'PHONE_VERIFICATION',
        phoneId: row.id,
        loginChallengeId: null,
        consumedAt: null,
      });
      expect(stored.codeHash).toMatch(/^smsh1\.[0-9a-f]{16}\.[0-9a-f]{64}$/);
      expect(stored.codeHash).not.toContain(message.code);
      expect(await smsStatus(user)).toMatchObject({
        available: true,
        eligible: true,
        enabled: false,
        pending: { phoneNumber: `••••••••${phone.slice(-2)}` },
      });

      const confirmed = await confirmPhone(user, message.code).expect(200);

      expect(dataOf<SmsStatusView>(confirmed)).toMatchObject({
        enabled: true,
        phoneNumber: `••••••••${phone.slice(-2)}`,
        verifiedAt: kit.clock.toISOString(),
        pending: null,
      });
      expect(
        await ctx.client.mfaSmsPhone.findUniqueOrThrow({
          where: { id: row.id },
        }),
      ).toMatchObject({ status: 'ACTIVE', verifiedAt: kit.clock });
      expect((await codesOf(user))[0].consumedAt).toEqual(kit.clock);
      // The owner is told by email (captured).
      await eventually(
        () =>
          Promise.resolve(
            ctx.emails.sent.find(
              (e) =>
                e.kind === 'security-notification' &&
                e.to === user.email &&
                e.event === 'MFA_SMS_PHONE_ADDED',
            ),
          ),
        30_000,
        'the notification',
      );
      // Never the full number or the code in an API response.
      expect(JSON.stringify([started.body, confirmed.body])).not.toContain(
        phone.slice(2),
      );
    });

    it('refuses a wrong, an expired and an already used verification code', async () => {
      const { user } = await mfaUser();
      const phone = newPhone();
      await startPhone(user, phone).expect(201);
      const code = sms.lastCode(phone);

      const wrong = await confirmPhone(user, wrongCode(code)).expect(400);
      expect(messageOf(wrong)).toBe(
        'Invalid or expired SMS code. 4 attempt(s) remaining.',
      );
      kit.advance(5 * MIN);
      await confirmPhone(user, code).expect(400); // expired

      // A new start sends a new code; the previous one never works again.
      await startPhone(user, phone).expect(201);
      const second = sms.lastCode(phone);
      if (second !== code) {
        await confirmPhone(user, code).expect(400);
      }
      await confirmPhone(user, second).expect(200);
      // Used: nothing is waiting for verification any more.
      await confirmPhone(user, second).expect(409);
      expect(await smsStatus(user)).toMatchObject({ enabled: true });
    });

    it('is only for users with MFA enabled with an authenticator app', async () => {
      const user = await kit.createUser();
      const phone = newPhone();

      const refused = await startPhone(user, phone).expect(409);

      expect(messageOf(refused)).toBe(
        'SMS verification needs MFA with an authenticator app. Enable it first.',
      );
      expect(sms.to(phone)).toEqual([]);
      expect(
        await ctx.client.mfaSmsPhone.count({ where: { authId: user.id } }),
      ).toBe(0);
      expect(await smsStatus(user)).toMatchObject({
        eligible: false,
        enabled: false,
      });
    });

    it.each([
      'not a number',
      '4155550123',
      '+0123456789',
      '+1 415',
      '+1415555012345678',
    ])('rejects the number %p (400), sending nothing', async (phoneNumber) => {
      const { user } = await mfaUser();
      const before = sms.sent.length;

      await startPhone(user, phoneNumber).expect(400);

      expect(sms.sent.length).toBe(before);
      expect(
        await ctx.client.mfaSmsPhone.count({ where: { authId: user.id } }),
      ).toBe(0);
    });
  });

  describe('signing in with an SMS code', () => {
    it('offers SMS, sends a code and completes the sign-in, without an MFA proof for the session', async () => {
      const user = await smsUser();
      const challenge = await challengeOf(user);
      expect(challenge.methods).toEqual(['totp', 'recovery_code', 'sms']);
      expect(challenge.smsPhoneNumber).toBe(`••••••••${user.phone.slice(-2)}`);

      const sent = dataOf<SentView>(
        await sendCode(user, challenge.challengeToken).expect(200),
      );
      expect(sent).toEqual({
        sent: true,
        phoneNumber: `••••••••${user.phone.slice(-2)}`,
        expiresAt: challenge.expiresAt, // at most the challenge's lifetime
        deliveriesRemaining: 2,
      });
      const code = sms.lastCode(user.phone);
      expect(sms.to(user.phone).at(-1)?.body).toMatch(
        /^Your MuseCue sign-in code is \d{6}\./,
      );

      const signedIn = dataOf<{
        accessToken: string;
        refreshToken: string;
        mfaMethod: string;
        trustedDevice: null;
      }>(
        await complete(user, {
          challengeToken: challenge.challengeToken,
          smsCode: code,
        }).expect(200),
      );

      expect(signedIn).toMatchObject({ mfaMethod: 'sms', trustedDevice: null });
      await http()
        .get('/auth/mfa')
        .set({ Authorization: `Bearer ${signedIn.accessToken}` })
        .expect(200);
      const sid = (
        JSON.parse(
          Buffer.from(
            signedIn.accessToken.split('.')[1],
            'base64url',
          ).toString(),
        ) as { sid: string }
      ).sid;
      // SMS never counts as an MFA proof (administrators, step-up).
      expect(
        await ctx.client.refreshSession.findFirst({
          where: { familyId: sid },
          select: { mfaVerifiedAt: true, mfaVerifiedWith: true },
        }),
      ).toEqual({ mfaVerifiedAt: null, mfaVerifiedWith: null });
      const [stored] = (await codesOf(user)).filter(
        (c) => c.purpose === 'LOGIN',
      );
      expect(stored.consumedAt).toEqual(kit.clock);
      expect(
        await ctx.client.mfaLoginChallenge.count({
          where: { authId: user.id, consumedAt: null },
        }),
      ).toBe(0);
    });

    it('a code works once; wrong and used codes are refused', async () => {
      const user = await smsUser();
      const first = await challengeOf(user);
      await sendCode(user, first.challengeToken).expect(200);
      const code = sms.lastCode(user.phone);

      const wrong = await complete(user, {
        challengeToken: first.challengeToken,
        smsCode: wrongCode(code),
      }).expect(400);
      expect(messageOf(wrong)).toBe(
        'Invalid or expired SMS code. 4 attempt(s) remaining.',
      );
      await complete(user, {
        challengeToken: first.challengeToken,
        smsCode: code,
      }).expect(200);

      // The same code for a new challenge: used.
      kit.advance(SECOND);
      const second = await challengeOf(user);
      await complete(user, {
        challengeToken: second.challengeToken,
        smsCode: code,
      }).expect(400);
      // The first challenge is consumed too.
      await complete(user, {
        challengeToken: first.challengeToken,
        smsCode: code,
      }).expect(401);
    });

    it('an expired code is refused (codes live at most five minutes)', async () => {
      const user = await smsUser();
      const challenge = await challengeOf(user);
      await sendCode(user, challenge.challengeToken).expect(200);
      const [stored] = await codesOf(user).then((codes) =>
        codes.filter((c) => c.purpose === 'LOGIN'),
      );
      expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(
        5 * MIN,
      );
      // A longer lifetime is refused by the database.
      await expect(
        ctx.client.mfaSmsCode.create({
          data: {
            authId: user.id,
            phoneId: stored.phoneId,
            purpose: 'PHONE_VERIFICATION',
            codeHash: stored.codeHash,
            createdAt: kit.clock,
            expiresAt: new Date(kit.clock.getTime() + 5 * MIN + 1),
          },
        }),
      ).rejects.toThrow();

      kit.advance(5 * MIN);
      // (The challenge expired with it: the sign-in starts again.)
      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: sms.lastCode(user.phone),
      }).expect(401);
      const again = await challengeOf(user);
      await complete(user, {
        challengeToken: again.challengeToken,
        smsCode: sms.lastCode(user.phone),
      }).expect(400);
    });

    it('a new code replaces the previous one, and a code completes only its own challenge', async () => {
      const user = await smsUser();
      const other = await smsUser();
      const a = await challengeOf(user);
      await sendCode(user, a.challengeToken).expect(200);
      const firstCode = sms.lastCode(user.phone);
      kit.advance(30 * SECOND);
      await sendCode(user, a.challengeToken).expect(200);
      const secondCode = sms.lastCode(user.phone);
      kit.advance(SECOND);
      const b = await challengeOf(user);
      const theirs = await challengeOf(other);
      await sendCode(other, theirs.challengeToken).expect(200);

      const refused = [
        // replaced by the second code
        firstCode === secondCode
          ? null
          : { challengeToken: a.challengeToken, smsCode: firstCode },
        // sent for challenge A, not B
        { challengeToken: b.challengeToken, smsCode: secondCode },
        // another user's code
        {
          challengeToken: a.challengeToken,
          smsCode: sms.lastCode(other.phone),
        },
      ].filter((body) => body !== null);
      for (const body of refused) {
        await complete(user, body).expect(400);
      }
      await complete(user, {
        challengeToken: a.challengeToken,
        smsCode: secondCode,
      }).expect(200);
      expect(
        (await codesOf(user))
          .filter((c) => c.purpose === 'LOGIN')
          .map((c) => [c.consumedAt !== null, c.invalidatedAt !== null]),
      ).toEqual([
        [false, true],
        [true, false],
      ]);
    });

    it('sends at most three codes per 15 minutes (sign-in and verification codes together)', async () => {
      const user = await smsUser();
      const challenge = await challengeOf(user);
      for (let i = 0; i < 3; i++) {
        await sendCode(user, challenge.challengeToken).expect(200);
        kit.advance(10 * SECOND);
      }
      const before = sms.to(user.phone).length;

      const limited = await sendCode(user, challenge.challengeToken).expect(
        429,
      );
      expect(messageOf(limited)).toMatch(
        /^Too many SMS codes were sent\. Try again after /,
      );
      // Adding a number counts too, and changes nothing when refused.
      const other = newPhone();
      await startPhone(user, other).expect(429);
      expect(sms.to(other)).toEqual([]);
      expect(sms.to(user.phone).length).toBe(before);
      expect(
        await ctx.client.mfaSmsPhone.count({
          where: { authId: user.id, status: 'PENDING' },
        }),
      ).toBe(0);
      expect(
        (
          await ctx.client.authSecurity.findUniqueOrThrow({
            where: { authId: user.id },
          })
        ).mfaSmsSentAt,
      ).toHaveLength(3);

      // 15 minutes after the first, a code can be sent again.
      kit.advance(15 * MIN - 30 * SECOND);
      const later = await challengeOf(user);
      await sendCode(user, later.challengeToken).expect(200);
    });

    it('checks at most five codes per 15 minutes; then even the right code is refused', async () => {
      const user = await smsUser();
      const challenge = await challengeOf(user);
      await sendCode(user, challenge.challengeToken).expect(200);
      const code = sms.lastCode(user.phone);

      const failedAt = kit.clock;
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push(
          (
            await complete(user, {
              challengeToken: challenge.challengeToken,
              smsCode: wrongCode(code),
            })
          ).status,
        );
      }
      const blocked = await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: code,
      }).expect(429);

      expect(statuses).toEqual([400, 400, 400, 400, 400]);
      expect(messageOf(blocked)).toMatch(
        /^Too many SMS codes were entered\. Try again after /,
      );
      // The right code was not used up; the authenticator still works.
      const [stored] = (await codesOf(user)).filter(
        (c) => c.purpose === 'LOGIN',
      );
      expect(stored.consumedAt).toBeNull();
      await complete(user, {
        challengeToken: challenge.challengeToken,
        code: freshCode(user),
      }).expect(200);
      const history = await ctx.client.securityEvent.findMany({
        where: {
          authId: user.id,
          type: { in: ['MFA_VERIFICATION_FAILED', 'MFA_VERIFICATION_BLOCKED'] },
        },
      });
      expect(history.map((e) => e.type).sort()).toEqual([
        'MFA_VERIFICATION_BLOCKED',
        'MFA_VERIFICATION_FAILED',
        'MFA_VERIFICATION_FAILED',
        'MFA_VERIFICATION_FAILED',
        'MFA_VERIFICATION_FAILED',
      ]);
      expect(history.map((e) => e.details)).toEqual(
        expect.arrayContaining([
          { context: 'sign_in', method: 'sms', remainingAttempts: 4 },
          {
            context: 'sign_in',
            method: 'sms',
            blockedUntil: new Date(failedAt.getTime() + 15 * MIN).toISOString(),
          },
        ]),
      );

      // 15 minutes later SMS works again.
      kit.advance(15 * MIN);
      const later = await challengeOf(user);
      await sendCode(user, later.challengeToken).expect(200);
      await complete(user, {
        challengeToken: later.challengeToken,
        smsCode: sms.lastCode(user.phone),
      }).expect(200);
    });

    it('cannot trust the device with an SMS code', async () => {
      const user = await smsUser();
      const challenge = await challengeOf(user);
      await sendCode(user, challenge.challengeToken).expect(200);
      const code = sms.lastCode(user.phone);

      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: code,
        trustDevice: true,
      }).expect(400);
      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: code,
        code: freshCode(user),
      }).expect(400);

      expect(
        await ctx.client.mfaTrustedDevice.count({ where: { authId: user.id } }),
      ).toBe(0);
      // Refused before checking: the code still works.
      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: code,
      }).expect(200);
    });

    it('is unavailable without a verified number', async () => {
      const { user } = await mfaUser();
      // A number added but never verified does not receive sign-in codes.
      const phone = newPhone();
      await startPhone(user, phone).expect(201);
      const challenge = await challengeOf(user);
      expect(challenge.methods).toEqual(['totp', 'recovery_code']);
      expect(challenge).not.toHaveProperty('smsPhoneNumber');

      const refused = await sendCode(user, challenge.challengeToken).expect(
        409,
      );
      expect(messageOf(refused)).toBe(
        'SMS verification is not set up for this account',
      );
      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: sms.lastCode(phone), // the verification code
      }).expect(409);
      expect(sms.to(phone)).toHaveLength(1);
    });

    it('refuses unknown, expired and used challenges (401)', async () => {
      const user = await smsUser();
      await sendCode(user, `mfac_${'A'.repeat(43)}`).expect(401);
      await sendCode(user, 'not-a-token').expect(400);
      const challenge = await challengeOf(user);
      await complete(user, {
        challengeToken: challenge.challengeToken,
        code: freshCode(user),
      }).expect(200);
      await sendCode(user, challenge.challengeToken).expect(401);
      expect(sms.to(user.phone)).toHaveLength(1); // the verification code
    });

    it('a failed delivery answers 503 and its code never works', async () => {
      const user = await smsUser();
      const challenge = await challengeOf(user);
      sms.failNext();

      await sendCode(user, challenge.challengeToken).expect(503);

      const [stored] = (await codesOf(user)).filter(
        (c) => c.purpose === 'LOGIN',
      );
      expect(stored.invalidatedAt).not.toBeNull();
      await sendCode(user, challenge.challengeToken).expect(200);
      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: sms.lastCode(user.phone),
      }).expect(200);
    });
  });
});
