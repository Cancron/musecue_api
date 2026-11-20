// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type request from 'supertest';
import type { Logger } from 'winston';
import { UserRole } from '../src/auth/interfaces/auth.interface';
import { totpCode } from '../src/auth/mfa/mfa-totp';
import { CustomLoggerService } from '../src/common/services/custom-logger.service';
import { CapturingSmsSender } from './support/fake-sms';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  type TestApplication,
} from './support/infrastructure-flows';
import {
  dataOf,
  messageOf,
  MfaTestKit,
  MIN,
  PASSWORD,
  SECOND,
  type TestUser,
  wrongCode,
} from './support/mfa-e2e';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(180_000);

const HEADER = 'X-Step-Up-Token';
const VERIFY_MFA =
  'Verify MFA in this session (POST /auth/mfa/verify) to use administrator operations';

interface PhoneUser extends TestUser {
  phone: string;
  /** Password approvals of the SMS actions given before MFA was enabled. */
  preMfaApprovals: Record<string, string>;
}

type PhoneAction = 'MFA_SMS_ENROLLMENT' | 'MFA_SMS_REPLACE' | 'MFA_SMS_DISABLE';

/**
 * Security of SMS verification through the real endpoints of the whole
 * application on a temporary, freshly migrated PostgreSQL schema, with a
 * mocked SMS provider and captured emails:
 *
 * - adding, replacing and removing the phone number need a valid step-up
 *   approval (proven with the authenticator or a recovery code); without
 *   one: 403 and nothing changes (number, pending verification, codes,
 *   limits, history, notifications, no SMS sent);
 * - replacing or removing the number ends every SMS code sent before, at
 *   once;
 * - SMS completes only the MFA step of a normal sign-in: it never approves a
 *   step-up, never verifies MFA (POST /auth/mfa/verify), and an SMS sign-in
 *   is never the MFA proof administrators need;
 * - no phone number or code is ever logged or stored readable.
 */
describeWithDatabase('MFA SMS security (e2e, PostgreSQL)', () => {
  const sms = new CapturingSmsSender();
  let ctx: TestApplication;
  let kit: MfaTestKit;
  let numbers = 0;
  /** Everything the application logged during this suite. */
  const logged: unknown[][] = [];

  beforeAll(async () => {
    ctx = await bootApplication({ sms });
    kit = new MfaTestKit(ctx, '198.32');
    freezeTime(kit.clock);
    kit.nextStepStart();

    const capture = (...args: unknown[]) => {
      logged.push(args);
    };
    const winston = ctx.get<Logger>(WINSTON_MODULE_PROVIDER);
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(winston, level).mockImplementation(capture as never);
    }
    const custom = ctx.get<CustomLoggerService>(CustomLoggerService);
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(custom, level).mockImplementation(capture as never);
    }
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, level).mockImplementation(capture);
    }
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    await ctx?.close();
  });

  beforeEach(() => kit.nextStepStart(60 * MIN));

  const http = () => kit.http();
  const newNumber = () => `+4420795${String(10000 + ++numbers).slice(-5)}`;

  const freshCode = (user: TestUser) => {
    kit.nextStepStart();
    return totpCode(user.totpSecret as string, kit.clock);
  };

  /** An approval of `action` proven with the authenticator. */
  const mfaApproval = async (user: TestUser, action: string) =>
    dataOf<{ stepUpToken: string }>(
      await http()
        .post('/auth/step-up')
        .set(kit.as(user))
        .send({ action, code: freshCode(user) })
        .expect(201),
    ).stepUpToken;

  /** The phone routes: path and body. */
  const ROUTES: Record<
    string,
    { action: PhoneAction; path: string; body: (u: PhoneUser) => object }
  > = {
    'enrollment start': {
      action: 'MFA_SMS_ENROLLMENT',
      path: '/auth/mfa/sms/enrollment',
      body: () => ({ phoneNumber: newNumber() }),
    },
    'enrollment confirmation': {
      action: 'MFA_SMS_ENROLLMENT',
      path: '/auth/mfa/sms/enrollment/confirm',
      body: (u) => ({ code: sms.lastCodeTo(u.phone) }),
    },
    'replacement start': {
      action: 'MFA_SMS_REPLACE',
      path: '/auth/mfa/sms/replacement',
      body: () => ({ phoneNumber: newNumber() }),
    },
    'replacement confirmation': {
      action: 'MFA_SMS_REPLACE',
      path: '/auth/mfa/sms/replacement/confirm',
      body: (u) => ({ code: sms.lastCodeTo(u.phone) }),
    },
    removal: {
      action: 'MFA_SMS_DISABLE',
      path: '/auth/mfa/sms/disable',
      body: () => ({}),
    },
  };

  const phoneRequest = (
    user: TestUser,
    path: string,
    body: object,
    token?: string,
  ): request.Test => {
    const test = http().post(path).set(kit.as(user));
    return (token === undefined ? test : test.set(HEADER, token)).send(body);
  };

  /**
   * A user with authenticator MFA (approved with the password for every SMS
   * action before enabling it). With `verified`, a verified number; with
   * `pending`, a verification code waiting at `phone` for `pending`.
   */
  async function smsUser(
    options: {
      verified?: boolean;
      pending?: 'MFA_SMS_ENROLLMENT' | 'MFA_SMS_REPLACE';
    } = {},
  ): Promise<PhoneUser> {
    const user = await kit.createUser();
    const preMfaApprovals: Record<string, string> = {};
    for (const action of [
      'MFA_SMS_ENROLLMENT',
      'MFA_SMS_REPLACE',
      'MFA_SMS_DISABLE',
    ]) {
      preMfaApprovals[action] = await kit.approve(user, action, {
        password: PASSWORD,
      });
    }
    await kit.enableMfa(user);
    let phone = newNumber();
    if (options.verified) {
      await phoneRequest(
        user,
        '/auth/mfa/sms/enrollment',
        { phoneNumber: phone },
        await mfaApproval(user, 'MFA_SMS_ENROLLMENT'),
      ).expect(202);
      kit.advance(SECOND);
      await phoneRequest(
        user,
        '/auth/mfa/sms/enrollment/confirm',
        { code: sms.lastCodeTo(phone) },
        await mfaApproval(user, 'MFA_SMS_ENROLLMENT'),
      ).expect(200);
    }
    if (options.pending) {
      phone = newNumber();
      await phoneRequest(
        user,
        options.pending === 'MFA_SMS_ENROLLMENT'
          ? '/auth/mfa/sms/enrollment'
          : '/auth/mfa/sms/replacement',
        { phoneNumber: phone },
        await mfaApproval(user, options.pending),
      ).expect(202);
    }
    kit.advance(SECOND);
    return { ...user, phone, preMfaApprovals };
  }

  /** Everything a phone change touches, to prove nothing changed. */
  async function snapshot(user: TestUser) {
    const where = { where: { authId: user.id } };
    return {
      phone: await ctx.client.mfaPhone.findUnique(where),
      codes: await ctx.client.mfaSmsCode.findMany({
        ...where,
        orderBy: { id: 'asc' },
      }),
      security: await ctx.client.authSecurity.findUnique(where),
      events: await ctx.client.securityEvent.count(where),
      audit: await ctx.client.activityLogEvent.count({
        where: { recordId: user.id },
      }),
      emails: await ctx.client.emailHistory.count(where),
      sms: sms.sent.length,
    };
  }

  /** Ways of asking without a valid step-up approval for `action`. */
  const refusals: Record<
    string,
    (
      user: PhoneUser,
      action: PhoneAction,
    ) => Promise<{ caller: TestUser; token?: string }>
  > = {
    'no approval': (user) => Promise.resolve({ caller: user }),
    'a malformed approval': (user) =>
      Promise.resolve({ caller: user, token: 'stup_forged' }),
    'an approval of another action': async (user, action) => ({
      caller: user,
      token: await mfaApproval(
        user,
        action === 'MFA_SMS_DISABLE' ? 'MFA_SMS_REPLACE' : 'MFA_SMS_DISABLE',
      ),
    }),
    'an expired approval': async (user, action) => {
      const token = await mfaApproval(user, action);
      kit.advance(10 * MIN);
      return { caller: user, token };
    },
    'an approval of another session': async (user, action) => {
      const token = await mfaApproval(user, action);
      const other = { ...user };
      await kit.signIn(other);
      return { caller: other, token };
    },
    'an approval of another user': async (user, action) => {
      const mallory = await smsUser();
      return { caller: user, token: await mfaApproval(mallory, action) };
    },
    'a password approval given before MFA was enabled': (user, action) =>
      Promise.resolve({ caller: user, token: user.preMfaApprovals[action] }),
  };

  /** The state each route is refused from. */
  const arrange = (route: string) =>
    route === 'enrollment start'
      ? smsUser()
      : route === 'enrollment confirmation'
        ? smsUser({ pending: 'MFA_SMS_ENROLLMENT' })
        : route === 'replacement confirmation'
          ? smsUser({ verified: true, pending: 'MFA_SMS_REPLACE' })
          : smsUser({ verified: true });

  describe('phone changes need a valid step-up approval', () => {
    const cases = Object.keys(ROUTES).flatMap((route) =>
      Object.keys(refusals).map((variant) => [route, variant] as const),
    );

    it.each(cases)(
      '%s with %s: 403, and nothing changes',
      async (route, variant) => {
        const { action, path, body } = ROUTES[route];
        const user = await arrange(route);
        const { caller, token } = await refusals[variant](user, action);
        const before = await snapshot(user);

        const refused = await phoneRequest(
          caller,
          path,
          body(user),
          token,
        ).expect(403);

        expect(messageOf(refused)).toMatch(/step-up/i);
        expect(await snapshot(user)).toEqual(before);
      },
    );

    it('with an approval proven with the authenticator, each change works', async () => {
      const user = await smsUser({ verified: true });
      const replacement = newNumber();

      await phoneRequest(
        user,
        '/auth/mfa/sms/replacement',
        { phoneNumber: replacement },
        await mfaApproval(user, 'MFA_SMS_REPLACE'),
      ).expect(202);
      await phoneRequest(
        user,
        '/auth/mfa/sms/replacement/confirm',
        { code: sms.lastCodeTo(replacement) },
        await mfaApproval(user, 'MFA_SMS_REPLACE'),
      ).expect(200);
      expect(
        (
          await ctx.client.mfaPhone.findUniqueOrThrow({
            where: { authId: user.id },
          })
        ).maskedNumber,
      ).toBe(`+${'*'.repeat(replacement.length - 5)}${replacement.slice(-4)}`);

      await phoneRequest(
        user,
        '/auth/mfa/sms/disable',
        {},
        await mfaApproval(user, 'MFA_SMS_DISABLE'),
      ).expect(200);
      expect(
        await ctx.client.mfaPhone.count({ where: { authId: user.id } }),
      ).toBe(0);
      // Each change was recorded and announced (no number in either).
      const types = (
        await ctx.client.securityEvent.findMany({
          where: { authId: user.id },
          select: { type: true },
        })
      ).map((e) => e.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'MFA_SMS_ENABLED',
          'MFA_SMS_PHONE_REPLACED',
          'MFA_SMS_DISABLED',
        ]),
      );
      const subjects = (
        await ctx.client.emailHistory.findMany({
          where: { authId: user.id, emailType: 'notification' },
          select: { subject: true },
        })
      ).map((e) => e.subject);
      expect(subjects).toEqual(
        expect.arrayContaining([
          'Security alert: a phone number was added for sign-in codes',
          'Security alert: your sign-in phone number was changed',
          'Security alert: SMS sign-in codes were turned off',
        ]),
      );
    });

    it('a user cannot confirm with the code sent to someone else’s number', async () => {
      const victim = await smsUser({ pending: 'MFA_SMS_ENROLLMENT' });
      const mallory = await smsUser({ pending: 'MFA_SMS_ENROLLMENT' });
      const before = await snapshot(victim);

      await phoneRequest(
        mallory,
        '/auth/mfa/sms/enrollment/confirm',
        { code: sms.lastCodeTo(victim.phone) },
        await mfaApproval(mallory, 'MFA_SMS_ENROLLMENT'),
      ).expect(400);

      const after = await snapshot(victim);
      expect(after.phone).toBeNull();
      expect(after.codes).toEqual(before.codes);
      expect(
        await ctx.client.mfaPhone.count({ where: { authId: mallory.id } }),
      ).toBe(0);
    });
  });

  describe('SMS codes end with the number they were sent to', () => {
    const challengeOf = async (user: TestUser) => {
      kit.advance(SECOND);
      return dataOf<{ challengeToken: string; methods: string[] }>(
        await kit.login(user).expect(201),
      );
    };
    const sendSms = (user: TestUser, challengeToken: string) =>
      http()
        .post('/auth/login/mfa/sms')
        .set('X-Forwarded-For', user.ip)
        .send({ challengeToken });
    const complete = (user: TestUser, body: object) =>
      http().post('/auth/login/mfa').set('X-Forwarded-For', user.ip).send(body);

    it('replacing the number invalidates every code sent before, at once', async () => {
      const user = await smsUser({ verified: true });
      const challenge = await challengeOf(user);
      await sendSms(user, challenge.challengeToken).expect(202);
      const oldCode = sms.lastCodeTo(user.phone);
      const replacement = newNumber();
      const approval = await mfaApproval(user, 'MFA_SMS_REPLACE');
      await phoneRequest(
        user,
        '/auth/mfa/sms/replacement',
        { phoneNumber: replacement },
        approval,
      ).expect(202);
      // Until the new number is confirmed, the old one keeps working: its
      // code is still open.
      expect(
        (
          await ctx.client.mfaSmsCode.findFirstOrThrow({
            where: { authId: user.id, purpose: 'SIGN_IN' },
          })
        ).invalidatedAt,
      ).toBeNull();

      kit.advance(SECOND);
      await phoneRequest(
        user,
        '/auth/mfa/sms/replacement/confirm',
        { code: sms.lastCodeTo(replacement) },
        approval,
      ).expect(200);

      // Not expired (less than five minutes), and refused all the same.
      const refused = await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: oldCode,
      }).expect(400);
      expect(messageOf(refused)).toMatch(/^Invalid or expired SMS code/);
      const codes = await ctx.client.mfaSmsCode.findMany({
        where: { authId: user.id, purpose: 'SIGN_IN' },
      });
      expect(codes.map((c) => [c.usedAt, c.invalidatedAt])).toEqual([
        [null, kit.clock],
      ]);
      // New codes go to the new number.
      kit.advance(16 * MIN);
      const next = await challengeOf(user);
      await sendSms(user, next.challengeToken).expect(202);
      expect(sms.sent.at(-1)!.to).toBe(replacement);
      await complete(user, {
        challengeToken: next.challengeToken,
        smsCode: sms.lastCodeTo(replacement),
      }).expect(200);
    });

    it('removing the number invalidates every code and SMS is no longer offered', async () => {
      const user = await smsUser({ verified: true });
      const challenge = await challengeOf(user);
      expect(challenge.methods).toContain('sms');
      await sendSms(user, challenge.challengeToken).expect(202);
      const code = sms.lastCodeTo(user.phone);

      await phoneRequest(
        user,
        '/auth/mfa/sms/disable',
        {},
        await mfaApproval(user, 'MFA_SMS_DISABLE'),
      ).expect(200);

      await complete(user, {
        challengeToken: challenge.challengeToken,
        smsCode: code,
      }).expect(409);
      expect(
        await ctx.client.mfaSmsCode.count({
          where: { authId: user.id, usedAt: null, invalidatedAt: null },
        }),
      ).toBe(0);
      await sendSms(user, challenge.challengeToken).expect(409);
      // The authenticator still completes the same sign-in.
      await complete(user, {
        challengeToken: challenge.challengeToken,
        code: freshCode(user),
      }).expect(200);
      const later = await challengeOf(user);
      expect(later.methods).toEqual(['totp', 'recovery_code']);
    });

    it('turning authenticator MFA off removes the number and every SMS code', async () => {
      const user = await smsUser({ verified: true });
      const challenge = await challengeOf(user);
      await sendSms(user, challenge.challengeToken).expect(202);

      await http()
        .post('/auth/mfa/disable')
        .set(kit.as(user))
        .set(HEADER, await mfaApproval(user, 'MFA_DISABLE'))
        .expect(200);

      expect(
        await ctx.client.mfaPhone.count({ where: { authId: user.id } }),
      ).toBe(0);
      expect(
        await ctx.client.mfaSmsCode.count({ where: { authId: user.id } }),
      ).toBe(0);
      // Without authenticator MFA there is no SMS at all.
      const status = dataOf<{ available: boolean; enabled: boolean }>(
        await http().get('/auth/mfa/sms').set(kit.as(user)).expect(200),
      );
      expect(status).toMatchObject({ available: false, enabled: false });
    });
  });

  describe('SMS completes only a normal sign-in', () => {
    /** Signs in with an SMS code; returns the session. */
    async function smsSession(user: PhoneUser): Promise<TestUser> {
      kit.advance(SECOND);
      const { challengeToken } = dataOf<{ challengeToken: string }>(
        await kit.login(user).expect(201),
      );
      await http()
        .post('/auth/login/mfa/sms')
        .set('X-Forwarded-For', user.ip)
        .send({ challengeToken })
        .expect(202);
      const tokens = dataOf<{ accessToken: string; mfaMethod: string }>(
        await http()
          .post('/auth/login/mfa')
          .set('X-Forwarded-For', user.ip)
          .send({ challengeToken, smsCode: sms.lastCodeTo(user.phone) })
          .expect(200),
      );
      expect(tokens.mfaMethod).toBe('sms');
      return { ...user, accessToken: tokens.accessToken };
    }

    it('never approves a step-up, for any sensitive action', async () => {
      const user = await smsUser({ verified: true });
      const session = await smsSession(user);
      const actions = [
        'DATA_EXPORT',
        'DATA_EXPORT_DOWNLOAD',
        'ACCOUNT_DELETION',
        'SUBSCRIPTION_CANCEL',
        'MFA_DISABLE',
        'MFA_RECOVERY_CODES',
        'MFA_AUTHENTICATOR_REPLACE',
        'MFA_SMS_ENROLLMENT',
        'MFA_SMS_REPLACE',
        'MFA_SMS_DISABLE',
      ];

      const approvals = await ctx.client.stepUpApproval.count({
        where: { authId: user.id },
      });
      for (const action of actions) {
        kit.advance(31 * SECOND); // (the route's rate limit)
        // A fresh SMS code (there is no way to get one outside sign-in, but
        // even a valid one is no step-up proof).
        await http()
          .post('/auth/step-up')
          .set(kit.as(session))
          .send({ action, smsCode: '123456' })
          .expect(400);
        await http()
          .post('/auth/step-up')
          .set(kit.as(session))
          .send({ action, method: 'sms', code: '123456' })
          .expect(400);
      }
      expect(
        await ctx.client.stepUpApproval.count({ where: { authId: user.id } }),
      ).toBe(approvals);
      // The SMS session must step up with the authenticator.
      await http().post('/v1/privacy/exports').set(kit.as(session)).expect(403);
      const approval = await mfaApproval(session, 'DATA_EXPORT');
      await http()
        .post('/v1/privacy/exports')
        .set(kit.as(session))
        .set(HEADER, approval)
        .expect(202);
    });

    it('a code sent by SMS does not work as an authenticator or verification code', async () => {
      const user = await smsUser({ verified: true });
      kit.advance(SECOND);
      const { challengeToken } = dataOf<{ challengeToken: string }>(
        await kit.login(user).expect(201),
      );
      await http()
        .post('/auth/login/mfa/sms')
        .set('X-Forwarded-For', user.ip)
        .send({ challengeToken })
        .expect(202);
      const code = sms.lastCodeTo(user.phone);
      const current = totpCode(user.totpSecret as string, kit.clock);
      const smsOnly = code === current ? wrongCode(code) : code;
      const approvals = await ctx.client.stepUpApproval.count({
        where: { authId: user.id },
      });

      await kit.verify(user, { smsCode: smsOnly }).expect(400);
      await kit.verify(user, { code: smsOnly }).expect(400); // not the app's
      await http()
        .post('/auth/step-up')
        .set(kit.as(user))
        .send({ action: 'DATA_EXPORT', code: smsOnly })
        .expect(400);
      expect(
        await ctx.client.stepUpApproval.count({ where: { authId: user.id } }),
      ).toBe(approvals);
      // The SMS code itself is still unused (only sign-in accepts it).
      expect(
        (
          await ctx.client.mfaSmsCode.findFirstOrThrow({
            where: { authId: user.id, purpose: 'SIGN_IN' },
          })
        ).usedAt,
      ).toBeNull();
    });

    it('an SMS sign-in is never the MFA proof administrators need', async () => {
      const admin = await smsUser({ verified: true });
      await ctx.client.authUser.update({
        where: { id: admin.id },
        data: { role: UserRole.ADMIN },
      });
      const session = await smsSession(admin);

      expect(
        await ctx.client.refreshSession.findFirst({
          where: { authId: admin.id, revokedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { mfaVerifiedAt: true, mfaVerifiedWith: true },
        }),
      ).toEqual({ mfaVerifiedAt: null, mfaVerifiedWith: null });
      const refused = await http()
        .get('/v1/admin/subscription-plan')
        .set(kit.as(session))
        .expect(403);
      expect(messageOf(refused)).toBe(VERIFY_MFA);

      // The authenticator in the same session is.
      await kit.verify(session, { code: freshCode(admin) }).expect(200);
      await http()
        .get('/v1/admin/subscription-plan')
        .set(kit.as(session))
        .expect(200);
    });
  });

  it('never logs or stores a phone number or SMS code readable', async () => {
    const numbersUsed = [...new Set(sms.sent.map((m) => m.to))];
    expect(numbersUsed.length).toBeGreaterThan(10);
    const logs = JSON.stringify(logged);
    const ids = (
      await ctx.client.authUser.findMany({ select: { id: true } })
    ).map((u) => u.id);
    const stored = JSON.stringify([
      await ctx.client.mfaPhone.findMany(),
      await ctx.client.mfaSmsCode.findMany(),
      await ctx.client.securityEvent.findMany({
        where: { authId: { in: ids } },
      }),
      await ctx.client.activityLogEventDetail.findMany({
        where: { event: { recordId: { in: ids } } },
      }),
      await ctx.client.emailHistory.findMany(),
    ]);
    const emails = JSON.stringify(ctx.emails.sent);
    for (const number of numbersUsed) {
      const national = number.slice(3);
      for (const [where, text] of [
        ['logs', logs],
        ['database', stored],
        ['emails', emails],
      ] as const) {
        expect([where, text.includes(national)]).toEqual([where, false]);
      }
    }
    // Codes: never a stored value (the HMAC is 64 hex characters), and no
    // message was logged. (Six digits alone could occur by chance in IDs.)
    for (const message of sms.sent) {
      expect(stored).not.toContain(`"${message.code}"`);
    }
    expect(logs).not.toMatch(/is your MuseCue/);
  });
});
