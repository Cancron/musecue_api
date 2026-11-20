// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { UserRole } from '../src/auth/interfaces/auth.interface';
import { totpCode } from '../src/auth/mfa/mfa-totp';
import { CustomLoggerService } from '../src/common/services/custom-logger.service';
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
  PASSWORD,
  SECOND,
  type TestUser,
} from './support/mfa-e2e';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(180_000);

const HEADER = 'X-Step-Up-Token';

interface SmsUser extends TestUser {
  phone: string;
  /** Password approvals given before MFA was enabled, by action. */
  preMfaApprovals: Record<string, string>;
}

type Operation = 'add or replace' | 'confirm' | 'remove';

/**
 * Security of SMS sign-in verification through the real endpoints of the
 * whole application on a temporary, freshly migrated PostgreSQL schema, with
 * the SMS provider mocked (FakeSmsProvider) and emails captured:
 *
 * - adding, replacing, confirming and removing a phone number need a valid
 *   step-up approval (authenticator or recovery code); without one: 403 and
 *   nothing changes;
 * - replacing or removing a number (or turning MFA off) invalidates every
 *   SMS code sent to it at once;
 * - SMS only completes a normal sign-in: it never approves a step-up,
 *   verifies MFA in a session, or counts for administrators, and codes are
 *   bound to their purpose;
 * - numbers and codes never leak into logs, records or responses.
 */
describeWithDatabase('MFA: SMS verification security (e2e)', () => {
  const sms = new FakeSmsProvider();
  let ctx: TestApplication;
  let kit: MfaTestKit;
  let phoneCounter = 0;
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
      const original = winston[level].bind(winston) as (
        ...a: unknown[]
      ) => unknown;
      jest.spyOn(winston, level).mockImplementation(((...args: unknown[]) => {
        capture(...args);
        return original(...args);
      }) as never);
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
  const newPhone = () => `+4420794${String(10000 + ++phoneCounter)}`;

  const freshCode = (user: TestUser) => {
    kit.nextStepStart();
    return totpCode(user.totpSecret as string, kit.clock);
  };

  /** A phone change with an explicit approval (or none). */
  const change = (
    user: TestUser,
    operation: Operation,
    token: string | undefined,
    body: Record<string, unknown> = {},
  ) => {
    const test =
      operation === 'add or replace'
        ? http().post('/auth/mfa/sms/phone')
        : operation === 'confirm'
          ? http().post('/auth/mfa/sms/phone/confirm')
          : http().delete('/auth/mfa/sms/phone');
    test.set(kit.as(user));
    if (token !== undefined) test.set(HEADER, token);
    return test.send(body);
  };

  /** The same with a valid MFA approval (lazy: awaiting sends it). */
  const approvedChange = (
    user: TestUser,
    operation: Operation,
    body: Record<string, unknown> = {},
  ) =>
    lazyRequest(async () => ({
      test: change(
        user,
        operation,
        await kit.approve(
          user,
          operation === 'remove' ? 'MFA_SMS_PHONE_REMOVE' : 'MFA_SMS_PHONE',
        ),
        body,
      ),
    }));

  /**
   * A user with authenticator MFA and a verified number. Before enabling
   * MFA, the user was approved with the password for every phone change
   * (worthless once MFA is on). By default signed in again 16 minutes later
   * (the SMS limits of the setup no longer count); with `laterSession:
   * false` still in the session (and within the ten minutes) of those
   * approvals.
   */
  async function smsUser(
    options: { role?: UserRole; laterSession?: boolean } = {},
  ): Promise<SmsUser> {
    const { role, laterSession = true } = options;
    const user = await kit.createUser();
    if (role) {
      await ctx.client.authUser.update({
        where: { id: user.id },
        data: { role },
      });
      await kit.signIn(user);
    }
    const preMfaApprovals: Record<string, string> = {};
    for (const action of ['MFA_SMS_PHONE', 'MFA_SMS_PHONE_REMOVE']) {
      preMfaApprovals[action] = await kit.approve(user, action, {
        password: PASSWORD,
      });
    }
    await kit.enableMfa(user);
    const phone = newPhone();
    await approvedChange(user, 'add or replace', {
      phoneNumber: phone,
    }).expect(201);
    await approvedChange(user, 'confirm', {
      code: sms.lastCode(phone),
    }).expect(200);
    if (laterSession) {
      kit.advance(16 * MIN);
      await kit.signIn(user);
    }
    return { ...user, phone, preMfaApprovals };
  }

  const challengeOf = async (user: TestUser) =>
    dataOf<{ challengeToken: string; methods: string[] }>(
      await kit.login(user).expect(201),
    );

  const sendCode = (user: TestUser, challengeToken: string) =>
    http()
      .post('/auth/login/mfa/sms')
      .set('X-Forwarded-For', user.ip)
      .send({ challengeToken });

  const complete = (user: TestUser, body: Record<string, unknown>) =>
    http().post('/auth/login/mfa').set('X-Forwarded-For', user.ip).send(body);

  /** Signs in with an SMS code; returns the session (its access token). */
  async function smsSession(user: SmsUser): Promise<TestUser> {
    const { challengeToken } = await challengeOf(user);
    await sendCode(user, challengeToken).expect(200);
    const tokens = dataOf<{ accessToken: string; mfaMethod: string }>(
      await complete(user, {
        challengeToken,
        smsCode: sms.lastCode(user.phone),
      }).expect(200),
    );
    expect(tokens.mfaMethod).toBe('sms');
    return { ...user, accessToken: tokens.accessToken };
  }

  /** Everything a phone change could touch. */
  async function stateOf(user: TestUser) {
    const where = { where: { authId: user.id } };
    return {
      phones: await ctx.client.mfaSmsPhone.findMany({
        ...where,
        orderBy: { createdAt: 'asc' },
      }),
      codes: await ctx.client.mfaSmsCode.findMany({
        ...where,
        orderBy: { createdAt: 'asc' },
      }),
      security: await ctx.client.authSecurity.findUnique({
        ...where,
        select: {
          mfaEnabled: true,
          mfaMethod: true,
          mfaSecret: true,
          mfaSmsSentAt: true,
          mfaSmsAttemptsAt: true,
        },
      }),
      events: await ctx.client.securityEvent.count(where),
      audit: await ctx.client.activityLogEvent.count({
        where: { recordId: user.id },
      }),
      emails: await ctx.client.emailHistory.count(where),
      sms: sms.sent.length,
    };
  }

  describe('phone changes need a valid step-up approval', () => {
    /** How a refused change is made: its caller and approval token. */
    const variants: Record<
      string,
      (
        user: SmsUser,
        action: string,
      ) => Promise<{ caller: TestUser; token?: string }>
    > = {
      'no approval': (user) => Promise.resolve({ caller: user }),
      'a malformed approval': (user) =>
        Promise.resolve({ caller: user, token: 'stup_forged' }),
      'an approval of another action': async (user, action) => ({
        caller: user,
        token: await kit.approve(
          user,
          action === 'MFA_SMS_PHONE' ? 'MFA_SMS_PHONE_REMOVE' : 'MFA_SMS_PHONE',
        ),
      }),
      'an expired approval': async (user, action) => {
        const token = await kit.approve(user, action);
        kit.advance(10 * MIN);
        return { caller: user, token };
      },
      'an approval of another session': async (user, action) => {
        const token = await kit.approve(user, action);
        const other = { ...user };
        await kit.signIn(other);
        return { caller: other, token };
      },
      'an approval of another user': async (user, action) => {
        const mallory = await kit.createUser();
        await kit.enableMfa(mallory);
        return { caller: user, token: await kit.approve(mallory, action) };
      },
      'a password approval given before MFA was enabled': (user, action) =>
        Promise.resolve({ caller: user, token: user.preMfaApprovals[action] }),
    };

    const cases = (['add or replace', 'confirm', 'remove'] as const).flatMap(
      (operation) =>
        Object.keys(variants).map((variant) => [operation, variant] as const),
    );

    it.each(cases)(
      '%s with %s: 403, and no number, code or setting changes',
      async (operation, variant) => {
        const user = await smsUser({
          laterSession: !variant.includes('before MFA'),
        });
        const next = newPhone();
        let body: Record<string, unknown> = {};
        if (operation === 'add or replace') body = { phoneNumber: next };
        if (operation === 'confirm') {
          // A replacement waiting for its (correct) code.
          await approvedChange(user, 'add or replace', {
            phoneNumber: next,
          }).expect(201);
          body = { code: sms.lastCode(next) };
        }
        const action =
          operation === 'remove' ? 'MFA_SMS_PHONE_REMOVE' : 'MFA_SMS_PHONE';
        const { caller, token } = await variants[variant](user, action);
        const before = await stateOf(user);

        const refused = await change(caller, operation, token, body).expect(
          403,
        );

        expect(messageOf(refused)).toMatch(/step-up/i);
        expect(await stateOf(user)).toEqual(before);
        // The verified number still receives sign-in codes.
        const { challengeToken, methods } = await challengeOf(user);
        expect(methods).toContain('sms');
        await sendCode(user, challengeToken).expect(200);
        expect(sms.to(user.phone).length).toBeGreaterThan(0);
      },
    );

    it('an SMS code can never approve a phone change (or any step-up)', async () => {
      const user = await smsUser();
      const session = await smsSession(user);
      const { challengeToken } = await challengeOf(user);
      await sendCode(user, challengeToken).expect(200);
      const smsCode = sms.lastCode(user.phone);

      for (const action of [
        'MFA_SMS_PHONE',
        'MFA_SMS_PHONE_REMOVE',
        'MFA_DISABLE',
        'ACCOUNT_DELETION',
      ]) {
        await http()
          .post('/auth/step-up')
          .set(kit.as(session))
          .send({ action, smsCode })
          .expect(400);
      }
      expect(
        await ctx.client.stepUpApproval.count({
          where: { authId: user.id, method: { notIn: ['PASSWORD'] } },
        }),
      ).toBe(
        // only the MFA approvals of the setup (adding the number)
        1,
      );
      // The code is not used up by these attempts.
      await complete(user, { challengeToken, smsCode }).expect(200);
    });
  });

  describe('SMS never satisfies step-up or protected MFA requirements', () => {
    it('a session signed in with SMS needs an authenticator step-up for every sensitive action', async () => {
      const user = await smsUser();
      const session = await smsSession(user);

      const sensitive = {
        'MFA disable': () => http().post('/auth/mfa/disable'),
        'recovery codes': () => http().post('/auth/mfa/recovery-codes'),
        'authenticator replacement': () =>
          http().post('/auth/mfa/authenticator/replacement'),
        'phone number': () =>
          http().post('/auth/mfa/sms/phone').send({ phoneNumber: newPhone() }),
        'phone removal': () => http().delete('/auth/mfa/sms/phone'),
        'subscription cancellation': () =>
          http().post('/v1/subscription/cancel'),
        'data export': () => http().post('/v1/privacy/exports'),
        'account deletion': () =>
          http()
            .post('/v1/privacy/account-deletion')
            .send({ password: PASSWORD, code: 'ABC123' }),
      };
      const before = await stateOf(user);
      for (const [what, request] of Object.entries(sensitive)) {
        const response = await request().set(kit.as(session));
        expect([what, response.status]).toEqual([what, 403]);
      }
      expect(await stateOf(user)).toEqual(before);
      // The authenticator still approves them in that session.
      await approvedChange(session, 'remove').expect(200);
    });

    it('an SMS code does not verify MFA in a session (POST /auth/mfa/verify)', async () => {
      const user = await smsUser();
      const session = await smsSession(user);
      const { challengeToken } = await challengeOf(user);
      await sendCode(user, challengeToken).expect(200);

      await kit
        .verify(session, { smsCode: sms.lastCode(user.phone) })
        .expect(400);
      await kit
        .verify(session, { code: sms.lastCode(user.phone), method: 'sms' })
        .expect(400);

      const sid = (
        JSON.parse(
          Buffer.from(
            session.accessToken.split('.')[1],
            'base64url',
          ).toString(),
        ) as { sid: string }
      ).sid;
      expect(
        await ctx.client.refreshSession.findFirst({
          where: { familyId: sid, revokedAt: null },
          select: { mfaVerifiedAt: true },
        }),
      ).toEqual({ mfaVerifiedAt: null });
    });

    it('an administrator signed in with SMS must verify MFA with the authenticator first', async () => {
      const admin = await smsUser({ role: UserRole.ADMIN });
      const session = await smsSession(admin);

      const refused = await http()
        .get('/v1/admin/subscription-plan')
        .set(kit.as(session))
        .expect(403);
      expect(messageOf(refused)).toBe(
        'Verify MFA in this session (POST /auth/mfa/verify) to use administrator operations',
      );

      await kit.verify(session, { code: freshCode(admin) }).expect(200);
      await http()
        .get('/v1/admin/subscription-plan')
        .set(kit.as(session))
        .expect(200);
    });

    it('codes are bound to their purpose: sign-in codes never verify a number, and the reverse', async () => {
      const user = await smsUser();
      const next = newPhone();
      await approvedChange(user, 'add or replace', {
        phoneNumber: next,
      }).expect(201);
      const verificationCode = sms.lastCode(next);
      const { challengeToken } = await challengeOf(user);
      await sendCode(user, challengeToken).expect(200);
      const signInCode = sms.lastCode(user.phone);

      if (signInCode !== verificationCode) {
        await approvedChange(user, 'confirm', { code: signInCode }).expect(400);
        await complete(user, {
          challengeToken,
          smsCode: verificationCode,
        }).expect(400);
      }

      // Each still works for its own purpose.
      await complete(user, { challengeToken, smsCode: signInCode }).expect(200);
      await approvedChange(user, 'confirm', { code: verificationCode }).expect(
        200,
      );
    });
  });

  describe('replacing or removing a number invalidates its codes at once', () => {
    it('replacing: the old number works until the new one is verified, then its codes stop at once', async () => {
      const user = await smsUser();
      const next = newPhone();
      await approvedChange(user, 'add or replace', {
        phoneNumber: next,
      }).expect(201);
      // Still the old number for sign-in codes while the new one is pending.
      const { challengeToken } = await challengeOf(user);
      await sendCode(user, challengeToken).expect(200);
      const oldCode = sms.lastCode(user.phone);
      const [oldPhone] = await ctx.client.mfaSmsPhone.findMany({
        where: { authId: user.id, status: 'ACTIVE' },
      });

      const confirmed = await approvedChange(user, 'confirm', {
        code: sms.lastCode(next),
      }).expect(200);

      expect(dataOf(confirmed)).toMatchObject({
        enabled: true,
        phoneNumber: `••••••••${next.slice(-2)}`,
      });
      const revoked = await ctx.client.mfaSmsPhone.findUniqueOrThrow({
        where: { id: oldPhone.id },
      });
      expect(revoked).toMatchObject({
        status: 'REVOKED',
        phoneNumber: null,
        revokedAt: kit.clock,
        revokedReason: 'replaced',
      });
      const oldCodes = await ctx.client.mfaSmsCode.findMany({
        where: { phoneId: oldPhone.id, consumedAt: null },
      });
      expect(oldCodes.every((c) => c.invalidatedAt !== null)).toBe(true);
      // The old number's unexpired code no longer completes the sign-in...
      await complete(user, { challengeToken, smsCode: oldCode }).expect(400);
      // ...and new codes go to the new number.
      await sendCode(user, challengeToken).expect(200);
      await complete(user, {
        challengeToken,
        smsCode: sms.lastCode(next),
      }).expect(200);
      await eventually(
        () =>
          Promise.resolve(
            ctx.emails.sent.find(
              (e) =>
                e.to === user.email && e.event === 'MFA_SMS_PHONE_REPLACED',
            ),
          ),
        30_000,
        'the notification',
      );
    });

    it('starting another replacement discards the pending number and its code', async () => {
      const user = await smsUser();
      const second = newPhone();
      const third = newPhone();
      await approvedChange(user, 'add or replace', {
        phoneNumber: second,
      }).expect(201);
      kit.advance(SECOND);
      await approvedChange(user, 'add or replace', {
        phoneNumber: third,
      }).expect(201);

      if (sms.lastCode(second) !== sms.lastCode(third)) {
        await approvedChange(user, 'confirm', {
          code: sms.lastCode(second),
        }).expect(400);
      }
      await approvedChange(user, 'confirm', {
        code: sms.lastCode(third),
      }).expect(200);
      expect(
        (
          await ctx.client.mfaSmsPhone.findMany({
            where: { authId: user.id },
            orderBy: { createdAt: 'asc' },
          })
        ).map((p) => [p.status, p.revokedReason]),
      ).toEqual([
        ['REVOKED', 'replaced'],
        ['REVOKED', 'superseded'],
        ['ACTIVE', null],
      ]);
    });

    it('removing: the number and every code sent to it stop working at once', async () => {
      const user = await smsUser();
      const pending = newPhone();
      await approvedChange(user, 'add or replace', {
        phoneNumber: pending,
      }).expect(201);
      const { challengeToken } = await challengeOf(user);
      await sendCode(user, challengeToken).expect(200);
      const code = sms.lastCode(user.phone);

      const removed = await approvedChange(user, 'remove').expect(200);

      expect(dataOf(removed)).toMatchObject({
        removed: true,
        enabled: false,
        phoneNumber: null,
        pending: null,
      });
      const rows = await ctx.client.mfaSmsPhone.findMany({
        where: { authId: user.id },
      });
      expect(rows.every((r) => r.status === 'REVOKED')).toBe(true);
      expect(rows.every((r) => r.phoneNumber === null)).toBe(true);
      expect(
        await ctx.client.mfaSmsCode.count({
          where: { authId: user.id, consumedAt: null, invalidatedAt: null },
        }),
      ).toBe(0);
      await complete(user, { challengeToken, smsCode: code }).expect(409);
      await sendCode(user, challengeToken).expect(409);
      await approvedChange(user, 'confirm', {
        code: sms.lastCode(pending),
      }).expect(409);
      kit.advance(SECOND);
      expect((await challengeOf(user)).methods).toEqual([
        'totp',
        'recovery_code',
      ]);
      await approvedChange(user, 'remove').expect(404);
      await eventually(
        () =>
          Promise.resolve(
            ctx.emails.sent.find(
              (e) => e.to === user.email && e.event === 'MFA_SMS_PHONE_REMOVED',
            ),
          ),
        30_000,
        'the notification',
      );
    });

    it('turning MFA off removes SMS too: numbers revoked, codes invalidated', async () => {
      const user = await smsUser();
      const { challengeToken } = await challengeOf(user);
      await sendCode(user, challengeToken).expect(200);

      await http()
        .post('/auth/mfa/disable')
        .set(kit.as(user))
        .set(HEADER, await kit.approve(user, 'MFA_DISABLE'))
        .expect(200);

      expect(
        await ctx.client.mfaSmsPhone.findMany({
          where: { authId: user.id },
          select: { status: true, revokedReason: true, phoneNumber: true },
        }),
      ).toEqual([
        { status: 'REVOKED', revokedReason: 'mfa_disabled', phoneNumber: null },
      ]);
      expect(
        await ctx.client.mfaSmsCode.count({
          where: { authId: user.id, consumedAt: null, invalidatedAt: null },
        }),
      ).toBe(0);
      // Without authenticator MFA, SMS cannot be set up again.
      user.totpSecret = undefined;
      await approvedChange(user, 'add or replace', {
        phoneNumber: newPhone(),
      }).expect(409);
    });
  });

  it('numbers and codes never appear in logs, records, emails or responses', async () => {
    expect(sms.sent.length).toBeGreaterThan(20);
    const numbers = [...new Set(sms.sent.map((m) => m.to))];
    const codes = new Set(sms.sent.map((m) => m.code));
    const ids = (
      await ctx.client.authUser.findMany({ select: { id: true } })
    ).map((u) => u.id);
    const records = JSON.stringify([
      await ctx.client.securityEvent.findMany({
        where: { authId: { in: ids } },
      }),
      await ctx.client.activityLogEventDetail.findMany({}),
      await ctx.client.emailHistory.findMany({}),
      await ctx.client.mfaSmsPhone.findMany({}),
    ]);
    const emails = JSON.stringify(ctx.emails.sent);
    const logs = logged
      .map((args) =>
        args
          .map((arg) =>
            arg instanceof Error
              ? `${arg.message} ${arg.stack}`
              : typeof arg === 'string'
                ? arg
                : JSON.stringify(arg),
          )
          .join(' '),
      )
      .join('\n');

    for (const number of numbers) {
      const digits = number.slice(1);
      for (const [where, text] of [
        ['records', records],
        ['emails', emails],
        ['logs', logs],
      ] as const) {
        expect([where, text.includes(digits)]).toEqual([where, false]);
      }
    }
    // Stored codes are HMACs; no event or audit detail holds a code.
    for (const stored of await ctx.client.mfaSmsCode.findMany({})) {
      expect(stored.codeHash).toMatch(/^smsh1\.[0-9a-f]{16}\.[0-9a-f]{64}$/);
    }
    const events = await ctx.client.securityEvent.findMany({
      where: { authId: { in: ids } },
    });
    for (const event of events) {
      for (const value of Object.values(event.details as object)) {
        expect(codes.has(String(value))).toBe(false);
      }
    }
    expect(records).not.toMatch(/"(smsCode|code)"\s*:/);
  });
});
