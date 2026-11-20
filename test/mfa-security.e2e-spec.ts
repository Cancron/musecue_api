// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { MfaSecretCipher } from '../src/auth/mfa/mfa-secret.cipher';
import { totpCode } from '../src/auth/mfa/mfa-totp';
import { CustomLoggerService } from '../src/common/services/custom-logger.service';
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
  type TestUser,
} from './support/mfa-e2e';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(120_000);

const HEADER = 'X-Step-Up-Token';

/**
 * MFA management through the real endpoints of the whole application on a
 * temporary, freshly migrated PostgreSQL schema: disabling MFA, replacing the
 * authenticator and regenerating recovery codes. Each needs a step-up
 * approval; refused requests change nothing in PostgreSQL; approved changes
 * invalidate the old secret, recovery codes and trusted devices as
 * documented, are recorded in the activity log and emailHistory, and send a
 * security notification. No secret, code or token ever appears in logs,
 * emails, records or later responses.
 */
describeWithDatabase('MFA security management (e2e, PostgreSQL)', () => {
  let ctx: TestApplication;
  let kit: MfaTestKit;
  /** Every secret, code and token seen during this suite. */
  const secrets = new Set<string>();
  /** Everything the application logged during this suite. */
  const logged: unknown[][] = [];

  beforeAll(async () => {
    ctx = await bootApplication();
    kit = new MfaTestKit(ctx, '198.24');
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
  const remember = (...values: Array<string | undefined>) =>
    values.forEach((v) => v && secrets.add(v));

  /**
   * A user with MFA enabled and one trusted device (from a real MFA
   * sign-in); all of its secrets are remembered for the final checks.
   */
  async function protectedUser() {
    const user = await kit.createUser();
    const { recoveryCodes } = await kit.enableMfa(user);
    const { challengeToken } = dataOf<{ challengeToken: string }>(
      await kit.login(user).expect(201),
    );
    kit.nextStepStart();
    const signedIn = dataOf<{
      accessToken: string;
      trustedDevice: { token: string };
    }>(
      await http()
        .post('/auth/login/mfa')
        .set('X-Forwarded-For', user.ip)
        .send({
          challengeToken,
          code: totpCode(user.totpSecret as string, kit.clock),
          trustDevice: true,
        })
        .expect(200),
    );
    user.accessToken = signedIn.accessToken;
    const deviceToken = signedIn.trustedDevice.token;
    remember(user.totpSecret, deviceToken, challengeToken, ...recoveryCodes);
    return { user, recoveryCodes, deviceToken };
  }

  /** Every PostgreSQL record of the user's MFA configuration. */
  async function snapshot(user: TestUser) {
    const where = { where: { authId: user.id } };
    return {
      security: await ctx.client.authSecurity.findUnique(where),
      recoveryCodes: await ctx.client.mfaRecoveryCode.findMany({
        ...where,
        orderBy: { id: 'asc' },
      }),
      enrollment: await ctx.client.mfaEnrollment.findUnique(where),
      devices: await ctx.client.mfaTrustedDevice.findMany({
        ...where,
        orderBy: { id: 'asc' },
      }),
      challenges: await ctx.client.mfaLoginChallenge.count(where),
      notifications: await ctx.client.emailHistory.count({
        where: { authId: user.id, emailType: 'notification' },
      }),
      audits: await ctx.client.activityLogEvent.count({
        where: { recordId: user.id },
      }),
    };
  }

  const notificationsTo = (user: TestUser) =>
    ctx.emails.sent.filter(
      (e) => e.kind === 'security-notification' && e.to === user.email,
    );

  /** The delivered notification and its emailHistory row. */
  async function deliveredNotification(user: TestUser, event: string) {
    const email = await eventually(
      () =>
        Promise.resolve(notificationsTo(user).find((e) => e.event === event)),
      60_000,
      `the ${event} notification`,
    );
    const row = await eventually(
      async () =>
        (await ctx.client.emailHistory.findFirst({
          where: {
            authId: user.id,
            emailType: 'notification',
            emailStatus: 'sent',
          },
          orderBy: { createdAt: 'desc' },
        })) ?? null,
      60_000,
      'the sent emailHistory row',
    );
    return { email, row };
  }

  /** The latest audit entry of the user, as field changes. */
  async function latestAudit(user: TestUser) {
    const event = await ctx.client.activityLogEvent.findFirstOrThrow({
      where: { tableName: 'authUser', recordId: user.id, eventType: 'update' },
      orderBy: { createdAt: 'desc' },
      include: { details: true },
    });
    return {
      event,
      changes: Object.fromEntries(
        event.details.map((d) => [d.fieldName, [d.oldValue, d.newValue]]),
      ),
    };
  }

  /** Sign-in through the API; returns the response body. */
  const signIn = async (user: TestUser) =>
    dataOf<{ mfaRequired: boolean; challengeToken?: string }>(
      await kit.login(user).expect(201),
    );

  const completeWith = (
    user: TestUser,
    challengeToken: string,
    factor: Record<string, string>,
  ) =>
    http()
      .post('/auth/login/mfa')
      .set('X-Forwarded-For', user.ip)
      .send({ challengeToken, ...factor });

  describe('refused without an approval: nothing changes', () => {
    const operations: Record<
      string,
      (user: TestUser, headers: Record<string, string>) => Promise<number>
    > = {
      'disable MFA': async (user, headers) =>
        (await http().post('/auth/mfa/disable').set(kit.as(user)).set(headers))
          .status,
      'start replacing the authenticator': async (user, headers) =>
        (
          await http()
            .post('/auth/mfa/authenticator/replacement')
            .set(kit.as(user))
            .set(headers)
        ).status,
      'confirm a replacement': async (user, headers) =>
        (
          await http()
            .post('/auth/mfa/authenticator/replacement/confirm')
            .set(kit.as(user))
            .set(headers)
            .send({ code: '123456' })
        ).status,
      'regenerate recovery codes': async (user, headers) =>
        (
          await http()
            .post('/auth/mfa/recovery-codes')
            .set(kit.as(user))
            .set(headers)
        ).status,
    };

    it.each(Object.keys(operations))('%s', async (operation) => {
      const { user } = await protectedUser();
      const other = await kit.createUser();
      // Approvals are obtained first: a step-up itself legitimately records
      // the authenticator step it used.
      const attempts = {
        'no approval': {},
        'a forged approval': { [HEADER]: `stup_${'A'.repeat(43)}` },
        // An approval of the same user for another action.
        'an approval for another action': {
          [HEADER]: await kit.approve(user, 'DATA_EXPORT'),
        },
        // Another user's approval for this kind of change.
        "another user's approval": {
          [HEADER]: await kit.approve(other, 'MFA_ENROLLMENT'),
        },
      };
      const before = await snapshot(user);
      const emailsBefore = notificationsTo(user).length;
      for (const [label, headers] of Object.entries(attempts)) {
        expect([label, await operations[operation](user, headers)]).toEqual([
          label,
          403,
        ]);
      }

      expect(await snapshot(user)).toEqual(before);
      expect(notificationsTo(user)).toHaveLength(emailsBefore);
    });
  });

  describe('disabling MFA (approved)', () => {
    it('turns MFA off and invalidates the secret, recovery codes and trusted devices', async () => {
      const { user, recoveryCodes, deviceToken } = await protectedUser();
      const { user: bystander } = await protectedUser();
      const bystanderBefore = await snapshot(bystander);
      const approval = await kit.approve(user, 'MFA_DISABLE'); // app code
      remember(approval);

      const response = await http()
        .post('/auth/mfa/disable')
        .set(kit.as(user))
        .set(HEADER, approval)
        .expect(200);

      expect(dataOf(response)).toMatchObject({
        enabled: false,
        method: null,
        recoveryCodesRemaining: null,
        trustedDevicesRevoked: 1,
      });
      // PostgreSQL: configuration cleared, codes gone, devices revoked.
      const after = await snapshot(user);
      expect(after.security).toMatchObject({
        mfaEnabled: false,
        mfaMethod: null,
        mfaSecret: null,
        mfaLastUsedStep: null,
        mfaFailedAttemptsAt: [],
        mfaBlockedUntil: null,
      });
      expect(after.recoveryCodes).toEqual([]);
      expect(after.enrollment).toBeNull();
      expect(after.devices).toHaveLength(1);
      expect(after.devices[0].revokedAt).toEqual(kit.clock);

      // The old credentials no longer verify anything...
      for (const factor of [
        { code: totpCode(user.totpSecret as string, kit.clock) },
        { recoveryCode: recoveryCodes[1] },
      ]) {
        await http()
          .post('/auth/mfa/verify')
          .set(kit.as(user))
          .send(factor)
          .expect(409);
      }
      // ...sign-in needs only the password again, and step-up too.
      user.trustedDeviceToken = deviceToken;
      expect((await signIn(user)).mfaRequired).toBe(false);
      const { method } = dataOf<{ method: string }>(
        await http().get('/auth/step-up').set(kit.as(user)).expect(200),
      );
      expect(method).toBe('password');

      // Recorded and notified; other users untouched.
      const { changes } = await latestAudit(user);
      expect(changes).toEqual({
        mfaEnabled: ['true', 'false'],
        mfaMethod: ['totp', null],
        mfaRecoveryCodesRemaining: ['10', '0'],
        mfaTrustedDevicesRevoked: [null, '1'],
        stepUpMethod: [null, 'TOTP'],
      });
      const { email, row } = await deliveredNotification(user, 'MFA_DISABLED');
      expect(email.to).toBe(user.email);
      expect(row).toMatchObject({
        emailTo: user.email,
        emailType: 'notification',
        subject: 'Security alert: two-step verification was turned off',
      });
      expect(await snapshot(bystander)).toEqual(bystanderBefore);
    });

    it('is refused (409) when MFA is already off', async () => {
      const user = await kit.createUser();
      const approval = await kit.approve(user, 'MFA_DISABLE'); // password
      const response = await http()
        .post('/auth/mfa/disable')
        .set(kit.as(user))
        .set(HEADER, approval)
        .expect(409);
      expect(messageOf(response)).toBe('MFA is not enabled for this account');
      expect(notificationsTo(user)).toEqual([]);
    });
  });

  describe('replacing the authenticator (approved)', () => {
    it('accepts only the new app afterwards and signs out trusted devices', async () => {
      const { user, recoveryCodes, deviceToken } = await protectedUser();
      const oldSecret = user.totpSecret as string;
      const before = await snapshot(user);
      const approval = await kit.approve(user, 'MFA_AUTHENTICATOR_REPLACE', {
        recoveryCode: recoveryCodes[0],
      });
      remember(approval);

      const started = dataOf<{ secret: string; otpauthUrl: string }>(
        await http()
          .post('/auth/mfa/authenticator/replacement')
          .set(kit.as(user))
          .set(HEADER, approval)
          .expect(201),
      );
      remember(started.secret);
      expect(started.secret).not.toBe(oldSecret);

      // The confirmation needs the approval too...
      kit.nextStepStart();
      const newCode = totpCode(started.secret, kit.clock);
      await http()
        .post('/auth/mfa/authenticator/replacement/confirm')
        .set(kit.as(user))
        .send({ code: newCode })
        .expect(403);
      // ...and a code of the new app (the old app's is refused).
      await http()
        .post('/auth/mfa/authenticator/replacement/confirm')
        .set(kit.as(user))
        .set(HEADER, approval)
        .send({ code: totpCode(oldSecret, kit.clock) })
        .expect(400);
      const confirmed = await http()
        .post('/auth/mfa/authenticator/replacement/confirm')
        .set(kit.as(user))
        .set(HEADER, approval)
        .send({ code: newCode })
        .expect(200);
      expect(dataOf(confirmed)).toMatchObject({
        enabled: true,
        method: 'totp',
        trustedDevicesRevoked: 1,
      });
      user.totpSecret = started.secret;

      // PostgreSQL: a new encrypted secret; devices revoked; codes kept.
      const after = await snapshot(user);
      expect(after.security!.mfaSecret).not.toBe(before.security!.mfaSecret);
      expect(
        ctx
          .get<MfaSecretCipher>(MfaSecretCipher)
          .decrypt('confirmed', user.id, after.security!.mfaSecret!),
      ).toBe(started.secret);
      expect(after.enrollment).toBeNull();
      expect(after.devices.every((d) => d.revokedAt !== null)).toBe(true);
      expect(after.recoveryCodes.map((c) => c.id)).toEqual(
        before.recoveryCodes.map((c) => c.id),
      );

      // At sign-in: the trusted device no longer skips MFA, the old app's
      // code is refused, the new one (and a recovery code) work.
      user.trustedDeviceToken = deviceToken;
      const { challengeToken } = await signIn(user);
      expect(challengeToken).toBeDefined();
      kit.nextStepStart();
      await completeWith(user, challengeToken as string, {
        code: totpCode(oldSecret, kit.clock),
      }).expect(400);
      await completeWith(user, challengeToken as string, {
        code: totpCode(started.secret, kit.clock),
      }).expect(200);
      const second = await signIn(user);
      await completeWith(user, second.challengeToken as string, {
        recoveryCode: recoveryCodes[1],
      }).expect(200);

      // Recorded and notified.
      const { changes } = await latestAuditOf(user, 'mfaAuthenticator');
      expect(changes).toEqual({
        mfaAuthenticator: [null, 'replaced'],
        mfaTrustedDevicesRevoked: [null, '1'],
        stepUpMethod: [null, 'RECOVERY_CODE'],
      });
      await deliveredNotification(user, 'MFA_AUTHENTICATOR_REPLACED');
    });

    it('keeps the current app when the replacement is not confirmed', async () => {
      const { user } = await protectedUser();
      const before = (await snapshot(user)).security;
      const approval = await kit.approve(user, 'MFA_AUTHENTICATOR_REPLACE');
      const started = dataOf<{ secret: string }>(
        await http()
          .post('/auth/mfa/authenticator/replacement')
          .set(kit.as(user))
          .set(HEADER, approval)
          .expect(201),
      );
      remember(started.secret);

      // Ten minutes later the pending secret is gone; nothing changed.
      kit.advance(10 * MIN);
      await kit.signIn(user); // with the current app
      await http()
        .post('/auth/mfa/authenticator/replacement/confirm')
        .set(kit.as(user))
        .set(HEADER, await kit.approve(user, 'MFA_AUTHENTICATOR_REPLACE'))
        .send({ code: totpCode(started.secret, kit.clock) })
        .expect(410);
      const after = (await snapshot(user)).security;
      expect(after!.mfaSecret).toBe(before!.mfaSecret);
      expect(notificationsTo(user)).toEqual([]);
    });
  });

  describe('regenerating recovery codes (approved)', () => {
    it('invalidates every previous code, keeps trusted devices, and notifies', async () => {
      const { user, recoveryCodes, deviceToken } = await protectedUser();
      const approval = await kit.approve(user, 'MFA_RECOVERY_CODES');
      remember(approval);

      const fresh = dataOf<{ recoveryCodes: string[] }>(
        await http()
          .post('/auth/mfa/recovery-codes')
          .set(kit.as(user))
          .set(HEADER, approval)
          .expect(201),
      ).recoveryCodes;
      remember(...fresh);

      const { challengeToken } = await signIn(user);
      await completeWith(user, challengeToken as string, {
        recoveryCode: recoveryCodes[2],
      }).expect(400);
      await completeWith(user, challengeToken as string, {
        recoveryCode: fresh[0],
      }).expect(200);
      // Regenerating codes does not affect trusted devices.
      user.trustedDeviceToken = deviceToken;
      expect((await signIn(user)).mfaRequired).toBe(false);

      const { changes } = await latestAuditOf(
        user,
        'mfaRecoveryCodesRemaining',
        '10',
      );
      expect(changes).toMatchObject({
        mfaRecoveryCodesRemaining: ['10', '10'],
        stepUpMethod: [null, 'TOTP'],
      });
      await deliveredNotification(user, 'MFA_RECOVERY_CODES_REGENERATED');
    });
  });

  /** The latest audit entry of the user that changed `field` (to `value`). */
  async function latestAuditOf(user: TestUser, field: string, value?: string) {
    const events = await ctx.client.activityLogEvent.findMany({
      where: { tableName: 'authUser', recordId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { details: true },
    });
    const event = events.find((e) =>
      e.details.some(
        (d) =>
          d.fieldName === field &&
          (value === undefined || d.newValue === value),
      ),
    );
    if (!event) throw new Error(`No audit entry changing ${field}`);
    return {
      changes: Object.fromEntries(
        event.details.map((d) => [d.fieldName, [d.oldValue, d.newValue]]),
      ),
    };
  }

  it('never exposed a secret, code or token in logs, emails or records', async () => {
    expect(secrets.size).toBeGreaterThan(20);
    const ids = (
      await ctx.client.authUser.findMany({ select: { id: true } })
    ).map((u) => u.id);
    const records = JSON.stringify([
      await ctx.client.activityLogEventDetail.findMany({
        where: { event: { recordId: { in: ids } } },
      }),
      await ctx.client.emailHistory.findMany({}),
      await ctx.client.activityLogEvent.findMany({
        where: { recordId: { in: ids } },
      }),
    ]);
    const emails = JSON.stringify(
      ctx.emails.sent.filter((e) => e.kind === 'security-notification'),
    );
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

    expect(
      ctx.emails.sent.some((e) => e.kind === 'security-notification'),
    ).toBe(true);
    for (const secret of secrets) {
      for (const [where, text] of [
        ['records', records],
        ['emails', emails],
        ['logs', logs],
      ] as const) {
        expect([where, text.includes(secret)]).toEqual([where, false]);
        if (secret.includes('-')) {
          expect([where, text.includes(secret.replace('-', ''))]).toEqual([
            where,
            false,
          ]);
        }
      }
    }
    // The notifications carry only the address, name, event and time.
    for (const email of ctx.emails.sent.filter(
      (e) => e.kind === 'security-notification',
    )) {
      expect(email.args).toHaveLength(4);
      expect(email.args![3]).toMatch(/^\d{4}-\d\d-\d\dT/);
    }
  });
});
