// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import { totpCode } from '../src/auth/mfa/mfa-totp';
import { CustomLoggerService } from '../src/common/services/custom-logger.service';
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

jest.setTimeout(120_000);

interface ActivityItem {
  id: string;
  type: string;
  createdAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  sessionId: string | null;
  currentSession: boolean;
  details: Record<string, unknown>;
}

interface ActivityPage {
  items: ActivityItem[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
}

interface TokensView {
  mfaRequired: boolean;
  accessToken?: string;
  refreshToken?: string;
  challengeToken?: string;
  trustedDevice?: { id: string; token: string };
}

/** The `sid` claim of an access token. */
const sidOf = (accessToken: string): string =>
  (
    JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
    ) as { sid: string }
  ).sid;

/** The only detail fields any event may carry (never a secret or code). */
const ALLOWED_DETAILS = new Set([
  'approvedWith',
  'blockedUntil',
  'context',
  'count',
  'deviceId',
  'deviceIds',
  'expiresAt',
  'includesCurrentSession',
  'method',
  'name',
  'reason',
  'recoveryCodes',
  'recoveryCodesDeleted',
  'remaining',
  'remainingAttempts',
  'scope',
  'sessionIds',
  'sessionsRevoked',
  'trustedDevicesRevoked',
]);

/**
 * The security activity history through the real endpoints of the whole
 * application on a temporary, freshly migrated PostgreSQL schema: MFA
 * enrollment and changes, failed MFA verifications, trusted-device changes
 * and session revocations are recorded for the account they concern, with
 * where they happened. Each user reads only their own history
 * (GET /v1/security/activity), newest first in a stable order, page by
 * page; no secret, code or token is ever part of it (or of the logs).
 */
describeWithDatabase('Security activity history (e2e, PostgreSQL)', () => {
  let ctx: TestApplication;
  let kit: MfaTestKit;
  /** Every secret, code and token seen during this suite. */
  const secrets = new Set<string>();
  /** Everything the application logged during this suite. */
  const logged: unknown[][] = [];

  beforeAll(async () => {
    ctx = await bootApplication();
    kit = new MfaTestKit(ctx, '198.28');
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

  const remember = (...values: (string | undefined)[]) => {
    for (const value of values) if (value) secrets.add(value);
  };

  /** GET /v1/security/activity (raw response). */
  const activity = (user: TestUser, query: Record<string, unknown> = {}) =>
    http().get('/v1/security/activity').set(kit.as(user)).query(query);

  const pageOf = async (user: TestUser, query: Record<string, unknown> = {}) =>
    dataOf<ActivityPage>(await activity(user, query).expect(200));

  /** The whole history of `user`, newest first. */
  const historyOf = async (user: TestUser) =>
    (await pageOf(user, { limit: 100 })).items;

  /** A fresh authenticator code (the next 30-second step, never used). */
  const freshCode = (user: TestUser) => {
    kit.nextStepStart();
    // (Six-digit codes are checked separately: as plain digits they could
    // occur by chance in IDs or times.)
    return totpCode(user.totpSecret as string, kit.clock);
  };

  /** A user with MFA enabled (through the API); returns the recovery codes. */
  async function mfaUser() {
    const user = await kit.createUser();
    remember(user.accessToken);
    const enabled = await kit.enableMfa(user);
    remember(enabled.secret, ...enabled.recoveryCodes);
    return { user, recoveryCodes: enabled.recoveryCodes };
  }

  /** Password sign-in; completes MFA with `factor` when asked. */
  async function signIn(
    user: TestUser,
    factor?: Record<string, unknown>,
  ): Promise<TokensView> {
    const first = dataOf<TokensView>(await kit.login(user).expect(201));
    remember(first.accessToken, first.refreshToken, first.challengeToken);
    if (!first.mfaRequired) return first;
    const done = dataOf<TokensView>(
      await http()
        .post('/auth/login/mfa')
        .set('X-Forwarded-For', user.ip)
        .send({
          challengeToken: first.challengeToken,
          ...(factor ?? { code: freshCode(user) }),
        })
        .expect(200),
    );
    remember(done.accessToken, done.refreshToken, done.trustedDevice?.token);
    return done;
  }

  /**
   * The history's types from oldest to newest, events of the same moment
   * (one transaction) grouped and sorted.
   */
  const chronology = (items: ActivityItem[]) => {
    const groups: { at: string; types: string[] }[] = [];
    for (const item of [...items].reverse()) {
      const last = groups[groups.length - 1];
      if (last && last.at === item.createdAt) last.types.push(item.type);
      else groups.push({ at: item.createdAt, types: [item.type] });
    }
    return groups.map((g) => g.types.sort());
  };

  it('records the MFA lifecycle of an account, in order, with where and how', async () => {
    const user = await kit.createUser();
    remember(user.accessToken);
    const other = await signIn(user); // a second session, ended by MFA
    const step = () => kit.advance(SECOND);

    // Enrollment: started, a wrong code, confirmed.
    const started = dataOf<{ secret: string }>(
      await kit.start(user).expect(201),
    );
    remember(started.secret);
    step();
    await kit
      .confirm(user, wrongCode(totpCode(started.secret, kit.clock)))
      .expect(400);
    step();
    const enabled = await kit
      .confirm(user, totpCode(started.secret, kit.clock))
      .expect(200);
    user.totpSecret = started.secret;
    const codes = dataOf<{ recoveryCodes: string[] }>(enabled).recoveryCodes;
    remember(...codes);

    // New recovery codes.
    step();
    const regenerated = dataOf<{ recoveryCodes: string[] }>(
      await kit.regenerate(user).expect(201),
    );
    remember(...regenerated.recoveryCodes);

    // A trusted device, then revoked by the user.
    step();
    const trusted = await signIn(user, {
      code: freshCode(user),
      trustDevice: true,
      deviceName: 'Work laptop',
    });
    const deviceId = trusted.trustedDevice?.id as string;
    step();
    await http()
      .delete(`/auth/mfa/trusted-devices/${deviceId}`)
      .set(kit.as(user))
      .expect(200);

    // A wrong code, then a recovery code, in this session.
    step();
    await kit.verify(user, { code: wrongCode(freshCode(user)) }).expect(400);
    step();
    await kit
      .verify(user, { recoveryCode: regenerated.recoveryCodes[0] })
      .expect(200);

    // A new authenticator app.
    step();
    const approval = await kit.approve(user, 'MFA_AUTHENTICATOR_REPLACE');
    remember(approval);
    const replacement = dataOf<{ secret: string }>(
      await http()
        .post('/auth/mfa/authenticator/replacement')
        .set(kit.as(user))
        .set('X-Step-Up-Token', approval)
        .expect(201),
    );
    remember(replacement.secret);
    step();
    kit.nextStepStart();
    const newCode = totpCode(replacement.secret, kit.clock);
    await http()
      .post('/auth/mfa/authenticator/replacement/confirm')
      .set(kit.as(user))
      .set('X-Step-Up-Token', approval)
      .send({ code: newCode })
      .expect(200);
    user.totpSecret = replacement.secret;

    // The other sessions (the trusted-device sign-in) ended.
    step();
    await http()
      .post('/auth/sessions/revoke-others')
      .set(kit.as(user))
      .expect(200);

    // MFA turned off.
    step();
    const disableApproval = await kit.approve(user, 'MFA_DISABLE');
    remember(disableApproval);
    await http()
      .post('/auth/mfa/disable')
      .set(kit.as(user))
      .set('X-Step-Up-Token', disableApproval)
      .expect(200);

    const history = await historyOf(user);
    expect(chronology(history)).toEqual([
      ['MFA_ENROLLMENT_STARTED'],
      ['MFA_VERIFICATION_FAILED'],
      ['MFA_ENABLED', 'SESSION_REVOKED'],
      ['MFA_RECOVERY_CODES_REGENERATED'],
      ['TRUSTED_DEVICE_ADDED'],
      ['TRUSTED_DEVICE_REVOKED'],
      ['MFA_VERIFICATION_FAILED'],
      ['MFA_RECOVERY_CODE_USED'],
      ['MFA_AUTHENTICATOR_REPLACEMENT_STARTED'],
      ['MFA_AUTHENTICATOR_REPLACED'],
      ['SESSION_REVOKED'],
      ['MFA_DISABLED'],
    ]);

    const sid = sidOf(user.accessToken);
    const byType = (type: string) => history.filter((e) => e.type === type);
    // Where: this session's IP address; done from this session.
    for (const event of history.filter(
      (e) => e.type !== 'TRUSTED_DEVICE_ADDED',
    )) {
      expect(event).toMatchObject({
        ipAddress: user.ip,
        sessionId: sid,
        currentSession: true,
      });
    }
    // How: only non-sensitive facts.
    expect(byType('MFA_VERIFICATION_FAILED').map((e) => e.details)).toEqual([
      { context: 'verification', method: 'totp', remainingAttempts: 4 },
      { context: 'enrollment', method: 'totp', remainingAttempts: 4 },
    ]);
    expect(byType('MFA_ENABLED')[0].details).toEqual({
      method: 'totp',
      recoveryCodes: 10,
      sessionsRevoked: 1,
      trustedDevicesRevoked: 0,
    });
    expect(byType('SESSION_REVOKED').map((e) => e.details)).toEqual([
      {
        scope: 'others',
        count: 1,
        sessionIds: [sidOf(trusted.accessToken as string)],
        includesCurrentSession: false,
      },
      {
        scope: 'mfa_enabled',
        count: 1,
        sessionIds: [sidOf(other.accessToken as string)],
        includesCurrentSession: false,
      },
    ]);
    expect(byType('TRUSTED_DEVICE_ADDED')[0]).toMatchObject({
      ipAddress: user.ip,
      details: {
        deviceId,
        name: 'Work laptop',
        expiresAt: expect.any(String) as string,
      },
    });
    expect(byType('TRUSTED_DEVICE_REVOKED')[0].details).toEqual({
      reason: 'user',
      deviceId,
      name: 'Work laptop',
    });
    expect(byType('MFA_RECOVERY_CODE_USED')[0].details).toEqual({
      context: 'verification',
      remaining: 9,
    });
    expect(byType('MFA_RECOVERY_CODES_REGENERATED')[0].details).toEqual({
      count: 10,
      approvedWith: 'TOTP',
    });
    expect(byType('MFA_DISABLED')[0].details).toEqual({
      recoveryCodesDeleted: 9,
      trustedDevicesRevoked: 0,
      approvedWith: 'TOTP',
    });
  });

  it('records failed verifications at sign-in, step-up and verification, and the block', async () => {
    const { user } = await mfaUser();
    const attacker = { ...user, ip: '203.0.113.9' };

    // Sign-in with the password but a wrong code (from another address).
    const { challengeToken } = dataOf<TokensView>(
      await kit.login(attacker).expect(201),
    );
    await http()
      .post('/auth/login/mfa')
      .set('X-Forwarded-For', attacker.ip)
      .send({ challengeToken, code: wrongCode(freshCode(user)) })
      .expect(400);
    // Step-up and verification with wrong codes.
    await http()
      .post('/auth/step-up')
      .set(kit.as(user))
      .send({ action: 'DATA_EXPORT', code: wrongCode(freshCode(user)) })
      .expect(400);
    for (let i = 0; i < 2; i++) {
      await kit.verify(user, { code: wrongCode(freshCode(user)) }).expect(400);
    }
    kit.advance(SECOND);
    await kit.verify(user, { recoveryCode: 'ABCDE-FGHJK' }).expect(429);

    const failures = (await historyOf(user))
      .filter((e) => e.type.startsWith('MFA_VERIFICATION_'))
      .reverse();
    expect(failures.map((e) => [e.type, e.details])).toEqual([
      [
        'MFA_VERIFICATION_FAILED',
        { context: 'sign_in', method: 'totp', remainingAttempts: 4 },
      ],
      [
        'MFA_VERIFICATION_FAILED',
        { context: 'step_up', method: 'totp', remainingAttempts: 3 },
      ],
      [
        'MFA_VERIFICATION_FAILED',
        { context: 'verification', method: 'totp', remainingAttempts: 2 },
      ],
      [
        'MFA_VERIFICATION_FAILED',
        { context: 'verification', method: 'totp', remainingAttempts: 1 },
      ],
      [
        'MFA_VERIFICATION_BLOCKED',
        {
          context: 'verification',
          method: 'recovery_code',
          blockedUntil: new Date(kit.clock.getTime() + 15 * MIN).toISOString(),
        },
      ],
    ]);
    // The sign-in attempt: the attacker's address, no session yet.
    expect(failures[0]).toMatchObject({
      ipAddress: attacker.ip,
      sessionId: null,
      currentSession: false,
    });
    expect(failures[1]).toMatchObject({
      ipAddress: user.ip,
      sessionId: sidOf(user.accessToken),
      currentSession: true,
    });
  });

  it('records session revocations of every kind', async () => {
    const user = await kit.createUser();
    remember(user.accessToken);
    const sessions: TokensView[] = [];
    for (let i = 0; i < 4; i++) sessions.push(await signIn(user));
    const as = (s: TokensView) => ({
      ...user,
      accessToken: s.accessToken as string,
    });
    const [a, b, c, d] = sessions;

    kit.advance(SECOND);
    await http()
      .delete(`/auth/sessions/${sidOf(b.accessToken as string)}`)
      .set(kit.as(as(a)))
      .expect(200);
    kit.advance(SECOND);
    await http()
      .post('/auth/logout')
      .set(kit.as(as(c)))
      .send({ refreshToken: c.refreshToken })
      .expect(201);
    kit.advance(SECOND);
    await http()
      .post('/auth/sessions/revoke-others')
      .set(kit.as(as(a)))
      .expect(200);
    kit.advance(SECOND);
    await http()
      .post('/auth/sessions/revoke-all')
      .set(kit.as(as(a)))
      .expect(200);
    kit.advance(16 * MIN); // (sign-in rate limit: 5 per 15 minutes)
    const again = await signIn(user);
    kit.advance(SECOND);
    await http()
      .post('/auth/logout-all')
      .set(kit.as(as(again)))
      .expect(201);
    kit.advance(16 * MIN);
    const last = await signIn(user);

    const revocations = (await historyOf(as(last)))
      .filter((e) => e.type === 'SESSION_REVOKED')
      .reverse();
    const sid = (s: TokensView) => sidOf(s.accessToken as string);
    expect(revocations.map((e) => [e.sessionId, e.details])).toEqual([
      [
        sid(a),
        {
          scope: 'one',
          count: 1,
          sessionIds: [sid(b)],
          includesCurrentSession: false,
        },
      ],
      [
        sid(c),
        {
          scope: 'logout',
          count: 1,
          sessionIds: [sid(c)],
          includesCurrentSession: true,
        },
      ],
      [
        sid(a),
        {
          scope: 'others',
          count: 2, // createUser's session and d
          sessionIds: expect.arrayContaining([
            sid(d),
            sidOf(user.accessToken),
          ]) as string[],
          includesCurrentSession: false,
        },
      ],
      [
        sid(a),
        {
          scope: 'all',
          count: 1,
          sessionIds: [sid(a)],
          includesCurrentSession: true,
        },
      ],
      [
        sid(again),
        {
          scope: 'logout_all',
          count: 1,
          sessionIds: [sid(again)],
          includesCurrentSession: true,
        },
      ],
    ]);
  });

  it('records trusted devices revoked by the device limit and by disabling MFA', async () => {
    const { user } = await mfaUser();
    const devices: string[] = [];
    for (let i = 0; i < 11; i++) {
      if (i > 0 && i % 4 === 0) kit.advance(16 * MIN); // sign-in rate limit
      const signedIn = await signIn(user, {
        code: freshCode(user),
        trustDevice: true,
        deviceName: `device ${i}`,
      });
      devices.push(signedIn.trustedDevice?.id as string);
      user.accessToken = signedIn.accessToken as string;
    }
    kit.advance(SECOND);
    const approval = await kit.approve(user, 'MFA_DISABLE');
    await http()
      .post('/auth/mfa/disable')
      .set(kit.as(user))
      .set('X-Step-Up-Token', approval)
      .expect(200);

    const history = await historyOf(user);
    expect(
      history.filter((e) => e.type === 'TRUSTED_DEVICE_ADDED'),
    ).toHaveLength(11);
    const revoked = history
      .filter((e) => e.type === 'TRUSTED_DEVICE_REVOKED')
      .map((e) => e.details);
    expect(revoked).toEqual([
      { reason: 'mfa_disabled', count: 10 },
      { reason: 'device_limit', count: 1, deviceIds: [devices[0]] },
    ]);
  });

  describe('reading the history', () => {
    /** A user with `count` failed verifications, one per second. */
    async function userWithEvents(count: number) {
      const { user } = await mfaUser();
      for (let i = 0; i < count; i++) {
        if (i > 0 && i % 4 === 0) {
          // Stay below the lockout (5 failures in 15 minutes).
          kit.advance(16 * MIN);
          await kit.signIn(user);
        }
        await kit
          .verify(user, { code: wrongCode(freshCode(user)) })
          .expect(400);
      }
      await kit.signIn(user); // a fresh access token
      return user;
    }

    it('pages newest first, with stable, complete and non-overlapping pages', async () => {
      const user = await userWithEvents(9);
      const all = await historyOf(user);
      const total = all.length; // + MFA_ENROLLMENT_STARTED and MFA_ENABLED
      expect(total).toBe(11);

      const pages: ActivityPage[] = [];
      for (let page = 1; page <= 3; page++) {
        pages.push(await pageOf(user, { page, limit: 4 }));
      }
      expect(pages.map((p) => p.meta)).toEqual([
        {
          page: 1,
          limit: 4,
          total,
          totalPages: 3,
          hasPreviousPage: false,
          hasNextPage: true,
        },
        {
          page: 2,
          limit: 4,
          total,
          totalPages: 3,
          hasPreviousPage: true,
          hasNextPage: true,
        },
        {
          page: 3,
          limit: 4,
          total,
          totalPages: 3,
          hasPreviousPage: true,
          hasNextPage: false,
        },
      ]);
      expect(pages.flatMap((p) => p.items)).toEqual(all);
      // Newest first (then by ID).
      const keys = all.map((e) => [e.createdAt, e.id]);
      expect(keys).toEqual(
        [...keys].sort(([t1, i1], [t2, i2]) =>
          (t1 === t2 ? i1 < i2 : t1 < t2) ? 1 : -1,
        ),
      );
      // The same request gives the same page.
      expect(await pageOf(user, { page: 2, limit: 4 })).toEqual(pages[1]);
      // Past the end: empty.
      expect(await pageOf(user, { page: 9, limit: 4 })).toMatchObject({
        items: [],
        meta: { total, hasNextPage: false, hasPreviousPage: true },
      });
      // Default: the first 20.
      expect((await pageOf(user)).meta).toMatchObject({ page: 1, limit: 20 });
      expect((await activity(user).expect(200)).headers['cache-control']).toBe(
        'no-store',
      );
    });

    it('orders events of the same moment by ID, the same way every time', async () => {
      const { user } = await mfaUser();
      const at = new Date(kit.clock.getTime() - MIN);
      await ctx.client.securityEvent.createMany({
        data: Array.from({ length: 6 }, () => ({
          id: randomUUID(),
          authId: user.id,
          type: 'SESSION_REVOKED' as const,
          details: { scope: 'one', count: 1 },
          createdAt: at,
        })),
      });
      const sameMoment = async (limit: number) => {
        const items: ActivityItem[] = [];
        for (let page = 1; ; page++) {
          const result = await pageOf(user, { page, limit });
          items.push(...result.items);
          if (!result.meta.hasNextPage) break;
        }
        return items
          .filter((e) => e.createdAt === at.toISOString())
          .map((e) => e.id);
      };

      const ids = await sameMoment(100);
      expect(ids).toEqual([...ids].sort().reverse());
      expect(await sameMoment(1)).toEqual(ids);
      expect(await sameMoment(4)).toEqual(ids);
    });

    it('shows each user only their own history', async () => {
      const alice = await userWithEvents(1);
      const bob = await userWithEvents(1);
      const alices = (await historyOf(alice)).map((e) => e.id);
      const bobs = (await historyOf(bob)).map((e) => e.id);

      expect(alices.filter((id) => bobs.includes(id))).toEqual([]);
      const stored = await ctx.client.securityEvent.findMany({
        where: { id: { in: bobs } },
        select: { authId: true },
      });
      expect(new Set(stored.map((e) => e.authId))).toEqual(new Set([bob.id]));
      // No parameter can name another account.
      for (const query of [
        { userId: alice.id },
        { authId: alice.id },
        { user: alice.email },
      ]) {
        await activity(bob, query).expect(400);
      }
    });

    it('validates the query and needs a valid session', async () => {
      const user = await userWithEvents(0);
      for (const query of [
        { page: 0 },
        { page: -1 },
        { page: 'x' },
        { page: 1.5 },
        { limit: 0 },
        { limit: 101 },
        { limit: 'all' },
        { sort: 'asc' },
        { type: 'MFA_ENABLED' },
      ]) {
        const refused = await activity(user, query);
        expect([query, refused.status]).toEqual([query, 400]);
      }
      await pageOf(user, { limit: 100 });
      await http().get('/v1/security/activity').expect(401);

      await http()
        .post('/auth/sessions/revoke-all')
        .set(kit.as(user))
        .expect(200);
      const ended = await activity(user).expect(401);
      expect(messageOf(ended)).toMatch(/Please (sign in|login) again/);
    });

    it('is deleted with the account', async () => {
      const user = await userWithEvents(1);
      expect(
        await ctx.client.securityEvent.count({ where: { authId: user.id } }),
      ).toBeGreaterThan(0);

      await ctx.client.authUser.delete({ where: { id: user.id } });

      expect(
        await ctx.client.securityEvent.count({ where: { authId: user.id } }),
      ).toBe(0);
    });
  });

  it('never exposes a secret, code or token in the history or the logs', async () => {
    expect(secrets.size).toBeGreaterThan(30);
    remember(PASSWORD);
    const ids = (
      await ctx.client.authUser.findMany({ select: { id: true } })
    ).map((u) => u.id);
    const events = await ctx.client.securityEvent.findMany({
      where: { authId: { in: ids } },
    });
    expect(events.length).toBeGreaterThan(50);
    for (const event of events) {
      for (const key of Object.keys(event.details as object)) {
        expect([event.type, key, ALLOWED_DETAILS.has(key)]).toEqual([
          event.type,
          key,
          true,
        ]);
      }
    }
    const stored = JSON.stringify(events);
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
    // What the users read back (one of them, through the API).
    const anyone = await mfaUser();
    const served = JSON.stringify(await historyOf(anyone.user));

    for (const secret of secrets) {
      for (const [where, text] of [
        ['history', stored],
        ['API', served],
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
    expect(stored).not.toMatch(/"(secret|code|token|tokenHash|password)"/i);
    // No detail is a six-digit code.
    for (const event of events) {
      for (const value of Object.values(event.details as object)) {
        expect(String(value)).not.toMatch(/^\d{6}$/);
      }
    }
  });
});
