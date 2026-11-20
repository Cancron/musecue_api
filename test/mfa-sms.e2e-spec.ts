// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import { totpCode } from '../src/auth/mfa/mfa-totp';
import { MfaSmsRepository } from '../src/auth/mfa/sms/mfa-sms.repository';
import { CapturingSmsSender } from './support/fake-sms';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  eventually,
  type TestApplication,
} from './support/infrastructure-flows';
import {
  dataOf,
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
  smsPhone?: string;
}

interface SentView {
  purpose: string;
  maskedNumber: string;
  expiresAt: string;
  deliveriesRemaining: number;
}

interface SmsStatus {
  available: boolean;
  enabled: boolean;
  phone: { maskedNumber: string; verifiedAt: string } | null;
  pending: { purpose: string; maskedNumber: string; expiresAt: string } | null;
}

interface PhoneUser extends TestUser {
  /** The verified number (E.164). */
  phone: string;
}

/**
 * Optional SMS verification at sign-in, through the real endpoints of the
 * whole application on a temporary, freshly migrated PostgreSQL schema, with
 * a mocked SMS provider (messages are captured, never sent) and captured
 * emails.
 *
 * Users with authenticator MFA register and verify a phone number, then can
 * complete the MFA step of a sign-in with a six-digit code sent by SMS:
 * random, stored only as an HMAC, valid for 5 minutes and once. At most 3
 * codes are sent and 5 checked per user within 15 minutes. Users without
 * authenticator MFA or without a verified number cannot use SMS.
 */
describeWithDatabase('MFA SMS sign-in verification (e2e, PostgreSQL)', () => {
  const sms = new CapturingSmsSender();
  let ctx: TestApplication;
  let kit: MfaTestKit;
  let numbers = 0;

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

  // Far apart: the SMS and sign-in limits of other tests never matter.
  beforeEach(() => kit.nextStepStart(60 * MIN));

  const http = () => kit.http();

  /** A new, unused E.164 number. */
  const newNumber = () => `+1415555${String(1000 + ++numbers).slice(-4)}`;
  const masked = (e164: string) => `+*******${e164.slice(-4)}`;

  /** A fresh authenticator code (the next 30-second step, never used). */
  const freshCode = (user: TestUser) => {
    kit.nextStepStart();
    return totpCode(user.totpSecret as string, kit.clock);
  };

  async function mfaUser(): Promise<TestUser> {
    const user = await kit.createUser();
    await kit.enableMfa(user);
    return user;
  }

  const smsStatus = async (user: TestUser) =>
    dataOf<SmsStatus>(
      await http().get('/auth/mfa/sms').set(kit.as(user)).expect(200),
    );

  /** POST /auth/mfa/sms/enrollment with an authenticator step-up. */
  const startEnrollment = async (
    user: TestUser,
    phoneNumber: string,
    status: number,
  ) =>
    http()
      .post('/auth/mfa/sms/enrollment')
      .set(kit.as(user))
      .set(HEADER, await kit.approve(user, 'MFA_SMS_ENROLLMENT'))
      .send({ phoneNumber })
      .expect(status);

  const confirmEnrollment = async (
    user: TestUser,
    code: string,
    status: number,
  ) =>
    http()
      .post('/auth/mfa/sms/enrollment/confirm')
      .set(kit.as(user))
      .set(HEADER, await kit.approve(user, 'MFA_SMS_ENROLLMENT'))
      .send({ code })
      .expect(status);

  /** A user with authenticator MFA and a verified phone number. */
  async function phoneUser(): Promise<PhoneUser> {
    const user = await mfaUser();
    const phone = newNumber();
    await startEnrollment(user, phone, 202);
    kit.advance(SECOND);
    await confirmEnrollment(user, sms.lastCodeTo(phone), 200);
    return { ...user, phone };
  }

  /** Password sign-in of an MFA user: the challenge. */
  const challengeOf = async (user: TestUser) => {
    kit.advance(SECOND);
    const body = dataOf<ChallengeView>(await kit.login(user).expect(201));
    expect(body.mfaRequired).toBe(true);
    return body;
  };

  const sendSms = (user: TestUser, challengeToken: string) =>
    http()
      .post('/auth/login/mfa/sms')
      .set('X-Forwarded-For', user.ip)
      .send({ challengeToken });

  const complete = (user: TestUser, body: Record<string, unknown>) =>
    http().post('/auth/login/mfa').set('X-Forwarded-For', user.ip).send(body);

  const securityOf = (user: TestUser) =>
    ctx.client.authSecurity.findUniqueOrThrow({ where: { authId: user.id } });
  const codesOf = (user: TestUser) =>
    ctx.client.mfaSmsCode.findMany({
      where: { authId: user.id },
      orderBy: { createdAt: 'asc' },
    });

  describe('registering a phone number', () => {
    it('verifies the number with a code sent to it; only masked numbers are shown or stored readable', async () => {
      const user = await mfaUser();
      const phone = newNumber();
      expect(await smsStatus(user)).toEqual({
        available: true,
        enabled: false,
        phone: null,
        pending: null,
      });

      // Formatting characters are accepted and removed.
      const formatted = `+1 (415) 555-${phone.slice(-4)}`;
      const started = await startEnrollment(user, formatted, 202);

      expect(dataOf<SentView>(started)).toEqual({
        purpose: 'enrollment',
        maskedNumber: masked(phone),
        expiresAt: new Date(kit.clock.getTime() + 5 * MIN).toISOString(),
        deliveriesRemaining: 2,
      });
      expect(started.headers['cache-control']).toBe('no-store');
      const message = sms.to(phone).at(-1)!;
      expect(message.body).toMatch(/^\d{6} is your MuseCue code/);
      expect(await smsStatus(user)).toMatchObject({
        enabled: false,
        pending: {
          purpose: 'enrollment',
          maskedNumber: masked(phone),
        },
      });
      // Stored: an HMAC of the code and the encrypted number, never either.
      const [row] = await codesOf(user);
      expect(row).toMatchObject({
        purpose: 'PHONE_ENROLLMENT',
        maskedNumber: masked(phone),
        codeHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        expiresAt: new Date(kit.clock.getTime() + 5 * MIN),
        usedAt: null,
      });
      expect(JSON.stringify(row)).not.toContain(message.code);
      expect(JSON.stringify(row)).not.toContain(phone.slice(2));

      const confirmed = await confirmEnrollment(user, message.code, 200);

      expect(dataOf<SmsStatus>(confirmed)).toEqual({
        available: true,
        enabled: true,
        phone: {
          maskedNumber: masked(phone),
          verifiedAt: kit.clock.toISOString(),
        },
        pending: null,
      });
      const stored = await ctx.client.mfaPhone.findUniqueOrThrow({
        where: { authId: user.id },
      });
      expect(stored.phoneNumber).toMatch(/^mfa2\./);
      expect(stored.phoneNumber).not.toContain(phone.slice(2));
      expect((await codesOf(user))[0].usedAt).toEqual(kit.clock);
      // The owner is told by email (mocked delivery).
      await eventually(
        () =>
          Promise.resolve(
            ctx.emails.sent.find(
              (e) =>
                e.to === user.email &&
                e.kind === 'security-notification' &&
                e.event === 'MFA_SMS_ENABLED',
            ),
          ),
        30_000,
        'the notification',
      );
    });

    it('refuses wrong, expired and superseded verification codes', async () => {
      const user = await mfaUser();
      const phone = newNumber();
      await startEnrollment(user, phone, 202);
      const first = sms.lastCodeTo(phone);

      const wrong = await confirmEnrollment(user, wrongCode(first), 400);
      expect(messageOf(wrong)).toBe(
        'Invalid or expired SMS code. 4 attempt(s) remaining.',
      );
      // Five minutes later the code has expired.
      kit.advance(5 * MIN);
      await confirmEnrollment(user, first, 400);
      // A new verification supersedes the previous code.
      kit.advance(SECOND);
      await startEnrollment(user, phone, 202);
      const second = sms.lastCodeTo(phone);
      if (second !== first) {
        await confirmEnrollment(user, first, 400);
      }
      await confirmEnrollment(user, second, 200);
      // Used: it cannot confirm anything again.
      expect((await smsStatus(user)).enabled).toBe(true);
      expect(
        (await codesOf(user)).map((c) => [
          c.usedAt !== null,
          c.invalidatedAt !== null,
        ]),
      ).toEqual([
        [false, true],
        [true, false],
      ]);
    });

    it('refuses invalid numbers and a second number (replace it instead)', async () => {
      const user = await phoneUser();
      const sent = sms.sent.length;

      for (const phoneNumber of ['4155550123', '+0123456789', '+1', 'abc']) {
        await startEnrollment(user, phoneNumber, 400);
      }
      const again = await startEnrollment(user, newNumber(), 409);
      expect(messageOf(again)).toMatch(/already registered/);
      expect(sms.sent.length).toBe(sent);
    });

    it('is not available without authenticator MFA', async () => {
      const user = await kit.createUser(); // no MFA: a password step-up
      const phone = newNumber();

      expect(await smsStatus(user)).toMatchObject({
        available: false,
        enabled: false,
      });
      const refused = await startEnrollment(user, phone, 409);
      expect(messageOf(refused)).toMatch(/authenticator-app MFA/);
      expect(sms.to(phone)).toEqual([]);
      expect(await codesOf(user)).toEqual([]);
      expect(
        await ctx.client.mfaPhone.count({ where: { authId: user.id } }),
      ).toBe(0);
    });
  });

  describe('signing in with an SMS code', () => {
    it('completes the MFA step with a code sent to the verified number, once', async () => {
      const user = await phoneUser();
      const challenge = await challengeOf(user);
      expect(challenge.methods).toEqual(['totp', 'recovery_code', 'sms']);
      expect(challenge.smsPhone).toBe(masked(user.phone));

      const sent = await sendSms(user, challenge.challengeToken).expect(202);
      expect(dataOf<SentView>(sent)).toEqual({
        purpose: 'sign_in',
        maskedNumber: masked(user.phone),
        expiresAt: new Date(kit.clock.getTime() + 5 * MIN).toISOString(),
        deliveriesRemaining: 1, // the verification used one
      });
      const code = sms.lastCodeTo(user.phone);
      expect(sms.to(user.phone).at(-1)!.body).toMatch(
        /^\d{6} is your MuseCue sign-in code/,
      );

      const response = await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: code,
      }).expect(200);

      const tokens = dataOf<{
        accessToken: string;
        refreshToken: string;
        mfaMethod: string;
        trustedDevice: unknown;
      }>(response);
      expect(tokens).toMatchObject({
        mfaMethod: 'sms',
        trustedDevice: null,
      });
      await http()
        .get('/auth/mfa')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);
      const [, signInCode] = await codesOf(user);
      expect(signInCode).toMatchObject({
        purpose: 'SIGN_IN',
        usedAt: kit.clock,
      });

      // Used: the same code never works again, not even for a new sign-in.
      kit.advance(16 * MIN);
      const next = await challengeOf(user);
      await complete(user, {
        challengeToken: next.challengeToken,
        smsCode: code,
      }).expect(400);
      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: code,
      }).expect(401); // that challenge is used up
    });

    it('refuses wrong codes, codes of another challenge or user, and earlier codes of a resent challenge', async () => {
      const alice = await phoneUser();
      const bob = await phoneUser();
      const other = await challengeOf(alice);
      const bobs = await challengeOf(bob);

      await sendSms(alice, other.challengeToken).expect(202);
      const otherCode = sms.lastCodeTo(alice.phone);
      await sendSms(bob, bobs.challengeToken).expect(202);
      const bobCode = sms.lastCodeTo(bob.phone);

      kit.advance(16 * MIN); // (Alice's SMS limit)
      const fresh = await challengeOf(alice);
      await sendSms(alice, fresh.challengeToken).expect(202);
      const first = sms.lastCodeTo(alice.phone);
      await sendSms(alice, fresh.challengeToken).expect(202); // resent
      const second = sms.lastCodeTo(alice.phone);

      const declined: [string, string][] = [
        ['a wrong code', wrongCode(second)],
        ['a code of another challenge', otherCode],
        ['another user’s code', bobCode],
      ];
      if (first !== second) declined.push(['the earlier code', first]);
      for (const [, smsCode] of declined) {
        const response = await complete(alice, {
          challengeToken: fresh.challengeToken,
          smsCode,
        });
        expect([response.status, messageOf(response)]).toEqual([
          400,
          expect.stringMatching(/^Invalid or expired SMS code\./),
        ]);
      }

      await complete(alice, {
        challengeToken: fresh.challengeToken,
        smsCode: second,
      }).expect(200);
    });

    it('refuses a code once it expired (5 minutes)', async () => {
      const user = await phoneUser();
      const challenge = await challengeOf(user);
      await sendSms(user, challenge.challengeToken).expect(202);
      const code = sms.lastCodeTo(user.phone);

      kit.advance(5 * MIN);

      // The challenge (also five minutes) has ended with it.
      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: code,
      }).expect(401);
      const [, row] = await codesOf(user);
      expect(row.usedAt).toBeNull();
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(kit.clock.getTime());
    });

    it('cannot trust the device (SMS is weaker than the authenticator), and nothing is used up', async () => {
      const user = await phoneUser();
      const challenge = await challengeOf(user);
      await sendSms(user, challenge.challengeToken).expect(202);
      const code = sms.lastCodeTo(user.phone);

      const refused = await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: code,
        trustDevice: true,
      }).expect(400);
      expect(messageOf(refused)).toMatch(
        /authenticator app or a recovery code/,
      );

      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: code,
      }).expect(200);
      expect(
        await ctx.client.mfaTrustedDevice.count({
          where: { authId: user.id },
        }),
      ).toBe(0);
    });

    it('exactly one factor: an SMS code with an authenticator code is refused', async () => {
      const user = await phoneUser();
      const challenge = await challengeOf(user);

      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: '123456',
        code: freshCode(user),
      }).expect(400);
      // The authenticator still completes it.
      await complete(user, {
        challengeToken: challenge.challengeToken,
        code: freshCode(user),
      }).expect(200);
    });

    it('is not offered to users without a verified number, nor to users without MFA', async () => {
      const user = await mfaUser();
      const challenge = await challengeOf(user);
      expect(challenge.methods).toEqual(['totp', 'recovery_code']);
      expect(challenge).not.toHaveProperty('smsPhone');

      const refused = await sendSms(user, challenge.challengeToken).expect(409);
      expect(messageOf(refused)).toMatch(/verified phone number/);
      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: '123456',
      }).expect(409);
      expect(await codesOf(user)).toEqual([]);
      expect((await securityOf(user)).mfaSmsAttemptsAt).toEqual([]);

      // No MFA: sign-in returns tokens, there is no challenge to send for.
      const plain = await kit.createUser();
      const login = dataOf<{ mfaRequired: boolean }>(
        await kit.login(plain).expect(201),
      );
      expect(login.mfaRequired).toBe(false);
      await sendSms(plain, `mfac_${'A'.repeat(43)}`).expect(401);
      await sendSms(plain, 'not-a-challenge').expect(400);
    });
  });

  describe('limits', () => {
    it('sends at most 3 SMS codes within 15 minutes', async () => {
      const user = await phoneUser(); // 1: the verification
      const challenge = await challengeOf(user);
      await sendSms(user, challenge.challengeToken).expect(202); // 2
      kit.advance(MIN);
      const third = await sendSms(user, challenge.challengeToken).expect(202);
      expect(dataOf<SentView>(third).deliveriesRemaining).toBe(0);
      const sent = sms.to(user.phone).length;
      const firstSent = (await codesOf(user))[0].createdAt;

      const limited = await sendSms(user, challenge.challengeToken).expect(429);
      expect(messageOf(limited)).toBe(
        `Too many SMS codes were sent. Try again after ${new Date(
          firstSent.getTime() + 15 * MIN,
        ).toISOString()}.`,
      );
      expect(sms.to(user.phone)).toHaveLength(sent);
      expect((await securityOf(user)).mfaSmsDeliveriesAt).toHaveLength(3);

      // Phone verification codes count too.
      await startEnrollment(user, newNumber(), 409); // (has one)
      const replacement = await http()
        .post('/auth/mfa/sms/replacement')
        .set(kit.as(user))
        .set(HEADER, await kit.approve(user, 'MFA_SMS_REPLACE'))
        .send({ phoneNumber: newNumber() })
        .expect(429);
      expect(messageOf(replacement)).toMatch(/^Too many SMS codes/);

      // Once the oldest leaves the 15 minutes, a code can be sent again.
      kit.advance(15 * MIN);
      const later = await challengeOf(user);
      await sendSms(user, later.challengeToken).expect(202);
    });

    it('checks at most 5 SMS codes within 15 minutes, then refuses even the right one', async () => {
      const user = await phoneUser(); // its confirmation was the 1st check
      const challenge = await challengeOf(user);
      await sendSms(user, challenge.challengeToken).expect(202);
      const code = sms.lastCodeTo(user.phone);

      const messages: string[] = [];
      for (let i = 0; i < 4; i++) {
        messages.push(
          messageOf(
            await complete(user, {
              challengeToken: challenge.challengeToken,
              smsCode: wrongCode(code),
            }).expect(400),
          ),
        );
      }
      expect(messages).toEqual([
        'Invalid or expired SMS code. 3 attempt(s) remaining.',
        'Invalid or expired SMS code. 2 attempt(s) remaining.',
        'Invalid or expired SMS code. 1 attempt(s) remaining.',
        'Invalid or expired SMS code. 0 attempt(s) remaining.',
      ]);
      const blocked = await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: code,
      }).expect(429);
      expect(messageOf(blocked)).toMatch(/^Too many SMS code attempts/);
      const [, row] = await codesOf(user);
      expect(row.usedAt).toBeNull();
      // The authenticator is not affected by the SMS limit.
      await complete(user, {
        challengeToken: challenge.challengeToken,
        code: freshCode(user),
      }).expect(200);

      // 15 minutes after the first check, SMS works again.
      kit.advance(15 * MIN);
      const later = await challengeOf(user);
      await sendSms(user, later.challengeToken).expect(202);
      await complete(user, {
        challengeToken: later.challengeToken,
        smsCode: sms.lastCodeTo(user.phone),
      }).expect(200);
    });

    it('a failed delivery answers 503, its code never works and it does not count', async () => {
      const user = await phoneUser();
      const challenge = await challengeOf(user);
      const before = (await securityOf(user)).mfaSmsDeliveriesAt;
      sms.failNext();

      await sendSms(user, challenge.challengeToken).expect(503);

      expect((await securityOf(user)).mfaSmsDeliveriesAt).toEqual(before);
      const [, failed] = await codesOf(user);
      expect(failed.invalidatedAt).toEqual(kit.clock);
      // A retry is sent and works.
      const retry = await sendSms(user, challenge.challengeToken).expect(202);
      expect(dataOf<SentView>(retry).deliveriesRemaining).toBe(1);
      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: sms.lastCodeTo(user.phone),
      }).expect(200);
    });
  });

  describe('failed deliveries', () => {
    it('a code whose delivery failed is never usable, even when ending it fails', async () => {
      const user = await phoneUser();
      const challenge = await challengeOf(user);
      const repository = ctx.get<MfaSmsRepository>(MfaSmsRepository);
      // The phone receives the message but the provider's answer is lost,
      // and the database cannot end the code afterwards.
      sms.deliverThenFail();
      sms.onSend = () => {
        jest
          .spyOn(repository, 'withLock')
          .mockRejectedValueOnce(new Error('database unavailable'));
      };

      await sendSms(user, challenge.challengeToken).expect(503);
      sms.onSend = undefined;

      const [, failed] = await codesOf(user);
      expect(failed).toMatchObject({
        purpose: 'SIGN_IN',
        deliveredAt: null,
        invalidatedAt: null, // the cleanup failed
        usedAt: null,
      });
      // The code that reached the phone does not work.
      const refused = await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: sms.lastCodeTo(user.phone),
      }).expect(400);
      expect(messageOf(refused)).toMatch(/^Invalid or expired SMS code/);
      // Nor can anything mark it used in PostgreSQL.
      await expect(
        ctx.client.mfaSmsCode.update({
          where: { id: failed.id },
          data: { usedAt: kit.clock },
        }),
      ).rejects.toThrow();
      expect(await smsStatus(user)).toMatchObject({ pending: null });
    });

    it('a sent code whose delivery cannot be recorded is never usable (503)', async () => {
      const user = await phoneUser();
      const challenge = await challengeOf(user);
      const repository = ctx.get<MfaSmsRepository>(MfaSmsRepository);
      jest
        .spyOn(repository, 'markDelivered')
        .mockRejectedValueOnce(new Error('database unavailable'));

      await sendSms(user, challenge.challengeToken).expect(503);

      const [, failed] = await codesOf(user);
      expect(failed.deliveredAt).toBeNull();
      expect(failed.invalidatedAt).toEqual(kit.clock);
      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: sms.lastCodeTo(user.phone),
      }).expect(400);
    });
  });

  it('records SMS activity in the security history without numbers or codes', async () => {
    const user = await phoneUser();
    const challenge = await challengeOf(user);
    await sendSms(user, challenge.challengeToken).expect(202);
    kit.advance(SECOND);
    await complete(user, {
      challengeToken: challenge.challengeToken,
      smsCode: wrongCode(sms.lastCodeTo(user.phone)),
    }).expect(400);

    const events = await ctx.client.securityEvent.findMany({
      where: { authId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    const smsEvents = events
      .filter((e) => e.type.includes('SMS') || e.type.includes('FAILED'))
      .map((e) => [e.type, e.details]);
    expect(smsEvents).toEqual([
      [
        'MFA_SMS_CODE_SENT',
        { purpose: 'phone_enrollment', phone: masked(user.phone) },
      ],
      [
        'MFA_SMS_ENABLED',
        {
          phone: masked(user.phone),
          previousPhone: null,
          codesInvalidated: 0,
          approvedWith: 'TOTP',
        },
      ],
      ['MFA_SMS_CODE_SENT', { purpose: 'sign_in', phone: masked(user.phone) }],
      [
        'MFA_VERIFICATION_FAILED',
        { context: 'sign_in', method: 'sms', remainingAttempts: 3 },
      ],
    ]);
    const text = JSON.stringify(events);
    expect(text).not.toContain(user.phone.slice(2));
    for (const message of sms.to(user.phone)) {
      expect(text).not.toContain(message.code);
    }
  });
});
