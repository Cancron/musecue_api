// Must be first: PostgreSQL-only infrastructure (REDIS_ENABLED=false, Redis
// unreachable) and test secrets, before any application module loads.
import './support/env-postgres-mode';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import {
  authenticatorCode,
  nextStepStart,
  wrongCode,
} from './support/authenticator-app';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  eventually,
  type TestApplication,
} from './support/infrastructure-flows';
import { describeWithDatabase } from './support/migrated-schema';
import { STEP_UP_HEADER, type StepUpAction } from './support/step-up';

jest.setTimeout(180_000);

const MFA_KEY = 'mfa-step-up-e2e-dedicated-key-0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const SECOND = 1_000;
const MINUTE = 60_000;
const DEVICE_HEADER = 'X-Trusted-Device-Token';
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

interface Envelope<T> {
  data: T;
  message: string;
}
interface Tokens {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string };
}
interface Approval {
  approvalToken: string;
  action: StepUpAction;
  method: 'TOTP' | 'RECOVERY_CODE' | 'PASSWORD' | 'GOOGLE';
  expiresAt: string;
}
interface Session {
  id: string;
  email: string;
  ip: string;
  accessToken: string;
  refreshToken: string;
}
interface MfaAccount extends Session {
  secret: string;
  codes: string[];
}
interface GoogleAccount {
  sub: string;
  email: string;
  ip: string;
}

const data = <T>(response: { body: unknown }) =>
  (response.body as Envelope<T>).data;
const message = (response: { body: unknown }) =>
  (response.body as { message: string }).message;
/** The sign-in session ID (`sid`) carried by an access token. */
const sidOf = (accessToken: string) =>
  (
    JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
    ) as { sid?: string }
  ).sid;

/**
 * Step-up authentication for sensitive actions, through the real HTTP
 * endpoints of the complete application on a temporary, freshly migrated
 * PostgreSQL schema (dropped afterwards). Google is replaced by a fake of its
 * token and userinfo endpoints; everything else is real.
 */
describeWithDatabase('Step-up authentication (e2e, PostgreSQL)', () => {
  let ctx: TestApplication;
  let ipCounter = 0;
  const originalEnv = {
    key: process.env.MFA_ENCRYPTION_KEY,
    googleId: process.env.GOOGLE_CLIENT_ID,
    googleSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirect: process.env.GOOGLE_REDIRECT_URI,
  };
  const realFetch = global.fetch;
  const googleCodes = new Map<string, { sub: string; email: string }>();

  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    process.env.MFA_ENCRYPTION_KEY = MFA_KEY;
    process.env.GOOGLE_CLIENT_ID = 'e2e-client.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'e2e-google-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost/auth/google/callback';
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        const body = typeof init?.body === 'string' ? init.body : '';
        const code = new URLSearchParams(body).get('code');
        const account = code ? googleCodes.get(code) : undefined;
        return account
          ? Response.json({
              access_token: `google-access-${account.sub}`,
              expires_in: 3600,
              scope: 'openid email profile',
              token_type: 'Bearer',
            })
          : Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        const account = [...googleCodes.values()].find(
          (a) => auth === `Bearer google-access-${a.sub}`,
        );
        return account
          ? Response.json({
              sub: account.sub,
              email: account.email,
              email_verified: true,
              name: 'Google User',
            })
          : Response.json({ error: 'invalid_token' }, { status: 401 });
      }
      return realFetch(input, init);
    });
    ctx = await bootApplication();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ctx?.close();
    for (const [name, value] of Object.entries({
      MFA_ENCRYPTION_KEY: originalEnv.key,
      GOOGLE_CLIENT_ID: originalEnv.googleId,
      GOOGLE_CLIENT_SECRET: originalEnv.googleSecret,
      GOOGLE_REDIRECT_URI: originalEnv.googleRedirect,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // ---------------------------------------------------------------- helpers

  let clock = 0;
  const travelTo = (ms: number) => {
    clock = ms;
    freezeTime(new Date(ms));
  };
  const travel = (ms: number) => travelTo(clock + ms);
  const startClock = () => travelTo(nextStepStart(Date.now()) + SECOND);
  const nextStep = () => travelTo(nextStepStart(clock) + SECOND);
  const nextIp = () => {
    ipCounter += 1;
    return `198.18.0.${ipCounter}`;
  };
  const bearer = (token: string) => `Bearer ${token}`;

  /** A verified local (password) account, signed in. */
  async function passwordAccount(): Promise<Session> {
    const tag = randomBytes(5).toString('hex');
    const email = `su_${tag}@example.com`;
    const ip = nextIp();
    await http()
      .post('/auth')
      .set('X-Forwarded-For', ip)
      .send({ username: `su_${tag}`, email, password: PASSWORD })
      .expect(201);
    const sent = await eventually(
      () =>
        Promise.resolve(
          ctx.emails.sent.find(
            (item) => item.kind === 'verification' && item.to === email,
          ),
        ),
      30_000,
      'the verification email',
    );
    await http()
      .post('/auth/verify-email')
      .set('X-Forwarded-For', ip)
      .send({ email, code: sent.code })
      .expect(201);
    await eventually(
      () =>
        Promise.resolve(
          ctx.emails.sent.find(
            (item) => item.kind === 'welcome' && item.to === email,
          ),
        ),
      30_000,
      'the welcome email',
    );
    return signIn({ email, ip });
  }

  /** A new password sign-in (a new session) for the account. */
  async function signIn(account: { email: string; ip: string }) {
    const tokens = data<Tokens>(
      await http()
        .post('/auth/login')
        .set('X-Forwarded-For', account.ip)
        .send({ email: account.email, password: PASSWORD })
        .expect(201),
    );
    return {
      id: tokens.user.id,
      email: account.email,
      ip: account.ip,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  const stepUpRequest = (session: Session, body: object) =>
    http()
      .post('/v1/auth/step-up')
      .set('X-Forwarded-For', session.ip)
      .set('Authorization', bearer(session.accessToken))
      .send(body);
  async function approve(
    session: Session,
    action: StepUpAction,
    factor: object,
  ): Promise<Approval> {
    return data<Approval>(
      await stepUpRequest(session, { action, ...factor }).expect(201),
    );
  }

  /** A local account with MFA enabled (the clock ends one TOTP step later). */
  async function mfaAccount(): Promise<MfaAccount> {
    const session = await passwordAccount();
    startClock();
    const { approvalToken } = await approve(session, 'MFA_SETTINGS', {
      password: PASSWORD,
    });
    const { secret } = data<{ secret: string }>(
      await http()
        .post('/v1/auth/mfa/enrollment')
        .set('Authorization', bearer(session.accessToken))
        .set(STEP_UP_HEADER, approvalToken)
        .expect(201),
    );
    const { recoveryCodes } = data<{ recoveryCodes: string[] }>(
      await http()
        .post('/v1/auth/mfa/enrollment/confirm')
        .set('Authorization', bearer(session.accessToken))
        .set(STEP_UP_HEADER, approvalToken)
        .send({ code: authenticatorCode(secret, clock) })
        .expect(200),
    );
    nextStep();
    return { ...session, secret, codes: recoveryCodes };
  }

  const newGoogleAccount = (): GoogleAccount => {
    const sub = `google-${randomBytes(5).toString('hex')}`;
    return { sub, email: `${sub}@example.com`, ip: nextIp() };
  };
  /** Google's authorization code for `account` (after a Google login). */
  const googleCode = (account: { sub: string; email: string }) => {
    const code = `code-${randomBytes(6).toString('hex')}`;
    googleCodes.set(code, { sub: account.sub, email: account.email });
    return code;
  };
  /** A Google sign-in (new session): the account's tokens. */
  async function googleSignIn(account: GoogleAccount): Promise<Session> {
    const { state } = data<{ state: string }>(
      await http()
        .get('/auth/google')
        .set('X-Forwarded-For', account.ip)
        .expect(200),
    );
    const result = data<{ data: Tokens }>(
      await http()
        .post('/auth/google/callback')
        .set('X-Forwarded-For', account.ip)
        .send({ code: googleCode(account), state })
        .expect(201),
    ).data;
    return {
      id: result.user.id,
      email: account.email,
      ip: account.ip,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }
  const startGoogle = (session: Session, body: object) =>
    http()
      .post('/v1/auth/step-up/google')
      .set('Authorization', bearer(session.accessToken))
      .send(body);
  const completeGoogle = (session: Session, body: object) =>
    http()
      .post('/v1/auth/step-up/google/callback')
      .set('Authorization', bearer(session.accessToken))
      .send(body);

  /** Calls a sensitive endpoint for `session`, with an optional approval. */
  const sensitive = (
    session: Session,
    method: 'get' | 'post' | 'delete',
    path: string,
    approval?: string,
    extraHeaders: Record<string, string> = {},
  ) => {
    const req = http()
      [method](path)
      .set('X-Forwarded-For', session.ip)
      .set('Authorization', bearer(session.accessToken));
    if (approval) req.set(STEP_UP_HEADER, approval);
    for (const [name, value] of Object.entries(extraHeaders)) {
      req.set(name, value);
    }
    return req;
  };
  const approvalRows = (authId: string) =>
    ctx.client.stepUpApproval.count({ where: { authId } });

  // ------------------------------------------------------------------ tests

  it('tells each account how it confirms sensitive actions', async () => {
    const password = await passwordAccount();
    const mfa = await mfaAccount();
    const google = await googleSignIn(newGoogleAccount());

    const requirement = async (session: Session) =>
      data<{ method: string; approvalTtlSeconds: number }>(
        await http()
          .get('/v1/auth/step-up')
          .set('Authorization', bearer(session.accessToken))
          .expect(200),
      );
    await expect(requirement(password)).resolves.toEqual({
      method: 'password',
      approvalTtlSeconds: 600,
    });
    await expect(requirement(mfa)).resolves.toMatchObject({ method: 'mfa' });
    await expect(requirement(google)).resolves.toMatchObject({
      method: 'google',
    });
    await http().get('/v1/auth/step-up').expect(401);
  });

  it('refuses every sensitive action without an approval (403) and changes nothing', async () => {
    const user = await mfaAccount();
    // A trusted device and a recovery code count for nothing here.
    const login = await http()
      .post('/auth/login')
      .set('X-Forwarded-For', user.ip)
      .send({ email: user.email, password: PASSWORD })
      .expect(201);
    const device = data<{
      accessToken: string;
      trustedDevice: { id: string; token: string };
    }>(
      await http()
        .post('/auth/mfa/challenge')
        .set('X-Forwarded-For', user.ip)
        .send({
          challengeToken: data<{ challengeToken: string }>(login)
            .challengeToken,
          code: authenticatorCode(user.secret, clock),
          trustDevice: true,
        })
        .expect(200),
    );
    const session = { ...user, accessToken: device.accessToken };
    const trusted = { [DEVICE_HEADER]: device.trustedDevice.token };
    const codesBefore = await ctx.client.mfaRecoveryCode.findMany({
      where: { authId: user.id },
      orderBy: { id: 'asc' },
    });
    // (Enabling MFA used one MFA_SETTINGS approval.)
    const approvalsBefore = await approvalRows(user.id);

    const exportId = '2f1d7e7a-8a1f-4f3c-9a59-0d1b7c1e9a11';
    const attempts: [string, 'get' | 'post' | 'delete', string][] = [
      ['start MFA enrollment', 'post', '/v1/auth/mfa/enrollment'],
      ['confirm MFA enrollment', 'post', '/v1/auth/mfa/enrollment/confirm'],
      ['regenerate recovery codes', 'post', '/v1/auth/mfa/recovery-codes'],
      [
        'revoke a trusted device',
        'delete',
        `/v1/auth/mfa/trusted-devices/${device.trustedDevice.id}`,
      ],
      ['cancel the subscription', 'post', '/v1/subscription/cancel'],
      ['request a data export', 'post', '/v1/privacy/exports'],
      [
        'get a download link',
        'get',
        `/v1/privacy/exports/${exportId}/download`,
      ],
      [
        'download an archive',
        'get',
        `/v1/privacy/exports/${exportId}/archive?expires=9999999999&signature=${'A'.repeat(43)}`,
      ],
      ['delete the account', 'post', '/v1/privacy/account-deletion'],
    ];
    for (const [what, method, path] of attempts) {
      for (const approval of [
        undefined,
        'not-a-token',
        randomBytes(32).toString('base64url'),
      ]) {
        const response = await sensitive(
          session,
          method,
          path,
          approval,
          trusted,
        )
          .send(path.endsWith('account-deletion') ? { code: 'ABC123' } : {})
          .expect(403);
        expect([what, message(response)]).toEqual([
          what,
          expect.stringContaining('Step-up authentication is required'),
        ]);
      }
    }

    // Nothing changed anywhere.
    expect(
      await ctx.client.mfaEnrollment.count({ where: { authId: user.id } }),
    ).toBe(0);
    expect(
      await ctx.client.mfaRecoveryCode.findMany({
        where: { authId: user.id },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(codesBefore);
    expect(
      await ctx.client.mfaTrustedDevice.findUniqueOrThrow({
        where: { id: device.trustedDevice.id },
      }),
    ).toMatchObject({ revokedAt: null });
    expect(
      await ctx.client.userSubscription.count({ where: { authId: user.id } }),
    ).toBe(0);
    expect(
      await ctx.client.dataExport.count({ where: { authId: user.id } }),
    ).toBe(0);
    expect(
      await ctx.client.accountDeletionRequest.count({
        where: { authId: user.id },
      }),
    ).toBe(0);
    expect(
      await ctx.client.authUser.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(
      await ctx.client.authSecurity.findUniqueOrThrow({
        where: { authId: user.id },
      }),
    ).toMatchObject({ mfaEnabled: true });

    // The trusted device does not replace the step-up itself either.
    await http()
      .post('/v1/auth/step-up')
      .set('Authorization', bearer(session.accessToken))
      .set(DEVICE_HEADER, device.trustedDevice.token)
      .send({ action: 'MFA_RECOVERY_CODES' })
      .expect(400);
    expect(await approvalRows(user.id)).toBe(approvalsBefore);
  });

  it('approves with the current password (accounts without MFA), for 10 minutes, only for its own user, session and action', async () => {
    const user = await passwordAccount();
    startClock();

    // Wrong password: refused, counted, no approval.
    expect(
      message(
        await stepUpRequest(user, {
          action: 'PRIVACY_EXPORT',
          password: 'wrong password',
        }).expect(403),
      ),
    ).toBe('Current password is incorrect');
    expect(
      await ctx.client.authSecurity.findUniqueOrThrow({
        where: { authId: user.id },
      }),
    ).toMatchObject({ failedAttempts: 1 });
    // An MFA code is not this account's factor.
    await stepUpRequest(user, {
      action: 'PRIVACY_EXPORT',
      code: '123456',
    }).expect(400);
    await stepUpRequest(user, { action: 'PRIVACY_EXPORT' }).expect(400);
    await stepUpRequest(user, {
      action: 'NOT_AN_ACTION',
      password: PASSWORD,
    }).expect(400);
    expect(await approvalRows(user.id)).toBe(0);

    const approval = await approve(user, 'PRIVACY_EXPORT', {
      password: PASSWORD,
    });
    expect(approval).toEqual({
      approvalToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      action: 'PRIVACY_EXPORT',
      method: 'PASSWORD',
      expiresAt: new Date(clock + 10 * MINUTE).toISOString(),
    });
    // PostgreSQL: bound to user, session and action; only the token's hash.
    const row = await ctx.client.stepUpApproval.findUniqueOrThrow({
      where: { tokenHash: sha256(approval.approvalToken) },
    });
    expect(row).toMatchObject({
      authId: user.id,
      sessionId: sidOf(user.accessToken),
      action: 'PRIVACY_EXPORT',
      method: 'PASSWORD',
      createdAt: new Date(clock),
      expiresAt: new Date(clock + 10 * MINUTE),
    });
    expect(
      await ctx.client.refreshSession.count({
        where: { authId: user.id, sessionId: row.sessionId, revokedAt: null },
      }),
    ).toBe(1);
    expect(JSON.stringify(row)).not.toContain(approval.approvalToken);
    // The correct password resets the counter.
    expect(
      await ctx.client.authSecurity.findUniqueOrThrow({
        where: { authId: user.id },
      }),
    ).toMatchObject({ failedAttempts: 0 });

    // Another action: refused.
    await sensitive(
      user,
      'post',
      '/v1/privacy/account-deletion',
      approval.approvalToken,
    )
      .send({ password: PASSWORD, code: 'ABC123' })
      .expect(403);
    // Another session of the same user: refused.
    const otherSession = await signIn(user);
    expect(sidOf(otherSession.accessToken)).not.toBe(sidOf(user.accessToken));
    await sensitive(
      otherSession,
      'post',
      '/v1/privacy/exports',
      approval.approvalToken,
    ).expect(403);
    // Another user: refused.
    const stranger = await passwordAccount();
    await sensitive(
      stranger,
      'post',
      '/v1/privacy/exports',
      approval.approvalToken,
    ).expect(403);
    expect(
      await ctx.client.dataExport.count({
        where: { authId: { in: [user.id, stranger.id] } },
      }),
    ).toBe(0);

    // Its own user, session and action: accepted (and reusable for 10
    // minutes, including after the access token was refreshed, since the
    // session stays the same).
    travel(9 * MINUTE);
    const refreshed = data<{ accessToken: string }>(
      await http()
        .post('/auth/refresh-token')
        .set('X-Forwarded-For', user.ip)
        .send({ refreshToken: user.refreshToken })
        .expect(201),
    );
    expect(sidOf(refreshed.accessToken)).toBe(sidOf(user.accessToken));
    const exported = data<{ id: string }>(
      await sensitive(
        { ...user, accessToken: refreshed.accessToken },
        'post',
        '/v1/privacy/exports',
        approval.approvalToken,
      ).expect(202),
    );
    expect(
      await ctx.client.stepUpApproval.findUniqueOrThrow({
        where: { id: row.id },
      }),
    ).toMatchObject({ lastUsedAt: new Date(clock) });

    // 10 minutes after it was issued it no longer works.
    travelTo(new Date(approval.expiresAt).getTime());
    await sensitive(
      { ...user, accessToken: refreshed.accessToken },
      'get',
      `/v1/privacy/exports/${exported.id}/download`,
      approval.approvalToken,
    ).expect(403);
    await sensitive(
      { ...user, accessToken: refreshed.accessToken },
      'post',
      '/v1/privacy/exports',
      approval.approvalToken,
    ).expect(403);

    // Signing out ends the session's approvals (the access token itself is
    // still valid for a few minutes).
    const fresh = await approve(otherSession, 'PRIVACY_EXPORT', {
      password: PASSWORD,
    });
    await http()
      .post('/auth/logout')
      .set('Authorization', bearer(otherSession.accessToken))
      .send({ refreshToken: otherSession.refreshToken })
      .expect(201);
    await sensitive(
      otherSession,
      'post',
      '/v1/privacy/exports',
      fresh.approvalToken,
    ).expect(403);
    // ... and no new approval can be issued for the ended session.
    await stepUpRequest(otherSession, {
      action: 'PRIVACY_EXPORT',
      password: PASSWORD,
    }).expect(401);

    // The database refuses an approval longer than 10 minutes.
    await expect(
      ctx.client.stepUpApproval.create({
        data: {
          authId: user.id,
          sessionId: row.sessionId,
          action: 'ACCOUNT_DELETION',
          method: 'PASSWORD',
          tokenHash: 'f'.repeat(64),
          createdAt: new Date(clock),
          expiresAt: new Date(clock + 11 * MINUTE),
        },
      }),
    ).rejects.toThrow(/StepUpApproval_expiresAt_check/);
  });

  it('approves MFA accounts only with an authenticator code or an unused recovery code', async () => {
    const user = await mfaAccount();
    const approvalsBefore = await approvalRows(user.id);

    // The password is not enough for an MFA account.
    expect(
      message(
        await stepUpRequest(user, {
          action: 'MFA_RECOVERY_CODES',
          password: PASSWORD,
        }).expect(400),
      ),
    ).toContain('MFA is enabled');
    // Wrong and malformed codes.
    await stepUpRequest(user, {
      action: 'MFA_RECOVERY_CODES',
      code: wrongCode(user.secret, clock),
    }).expect(400);
    await stepUpRequest(user, {
      action: 'MFA_RECOVERY_CODES',
      code: '12345',
    }).expect(400);
    await stepUpRequest(user, {
      action: 'MFA_RECOVERY_CODES',
      code: '123456',
      recoveryCode: user.codes[0],
    }).expect(400);
    expect(await approvalRows(user.id)).toBe(approvalsBefore);

    // The authenticator's current code, once.
    const viaTotp = await approve(user, 'MFA_RECOVERY_CODES', {
      code: authenticatorCode(user.secret, clock),
    });
    expect(viaTotp.method).toBe('TOTP');
    await stepUpRequest(user, {
      action: 'MFA_RECOVERY_CODES',
      code: authenticatorCode(user.secret, clock),
    }).expect(400);

    // An unused recovery code, once - also under concurrent requests. (A
    // new minute first: step-up allows 10 requests per minute per client.)
    travel(MINUTE);
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () =>
        stepUpRequest(user, {
          action: 'ACCOUNT_DELETION',
          recoveryCode: user.codes[0],
        }),
      ),
    );
    expect(concurrent.map((r) => r.status).sort()).toEqual([
      201, 400, 400, 400,
    ]);
    expect(
      data<Approval>(concurrent.find((r) => r.status === 201)!).method,
    ).toBe('RECOVERY_CODE');
    expect(
      await ctx.client.mfaRecoveryCode.count({
        where: { authId: user.id, usedAt: { not: null } },
      }),
    ).toBe(1);
    expect(
      await ctx.client.stepUpApproval.count({
        where: { authId: user.id, action: 'ACCOUNT_DELETION' },
      }),
    ).toBe(1);

    // The approval works for its action only.
    await sensitive(
      user,
      'post',
      '/v1/auth/mfa/enrollment',
      viaTotp.approvalToken,
    ).expect(403);
    const regenerated = await sensitive(
      user,
      'post',
      '/v1/auth/mfa/recovery-codes',
      viaTotp.approvalToken,
    ).expect(201);
    expect(
      data<{ recoveryCodes: string[] }>(regenerated).recoveryCodes,
    ).toHaveLength(10);
    // Old codes are replaced: none gives an approval any more.
    await stepUpRequest(user, {
      action: 'MFA_RECOVERY_CODES',
      recoveryCode: user.codes[1],
    }).expect(400);
  });

  it('re-authenticates Google-only accounts with a one-time Google challenge for their user, session and action', async () => {
    const account = newGoogleAccount();
    const user = await googleSignIn(account);
    startClock();

    // Neither a password nor an MFA code is this account's factor.
    expect(
      message(
        await stepUpRequest(user, {
          action: 'ACCOUNT_DELETION',
          password: 'anything',
        }).expect(400),
      ),
    ).toContain('POST /v1/auth/step-up/google');
    // Password and MFA accounts cannot use Google re-authentication.
    const local = await passwordAccount();
    await startGoogle(local, { action: 'ACCOUNT_DELETION' }).expect(400);

    // Start: a challenge bound to user, session and action.
    const started = data<{ url: string; state: string; expiresAt: string }>(
      await startGoogle(user, {
        action: 'ACCOUNT_DELETION',
        redirectUrl: 'https://app.example.com/step-up',
      }).expect(201),
    );
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      state: started.state,
      login_hint: account.email,
      prompt: 'select_account',
      code_challenge_method: 'S256',
      redirect_uri: 'http://localhost/auth/google/callback',
    });
    expect(started.expiresAt).toBe(new Date(clock + 10 * MINUTE).toISOString());
    const challenge = await ctx.client.stepUpChallenge.findUniqueOrThrow({
      where: { stateHash: sha256(started.state) },
    });
    expect(challenge).toMatchObject({
      authId: user.id,
      sessionId: sidOf(user.accessToken),
      action: 'ACCOUNT_DELETION',
      consumedAt: null,
    });
    expect(challenge.codeVerifier).toMatch(/^v1\./);

    // Google redirects the browser to the shared callback, which forwards
    // code and state to the app without using the challenge.
    const code = googleCode(account);
    const forwarded = await http()
      .get('/auth/google/callback')
      .query({ code, state: started.state })
      .expect(302);
    const target = new URL(forwarded.headers.location);
    expect(target.origin + target.pathname).toBe(
      'https://app.example.com/step-up',
    );
    expect(target.searchParams.get('step_up_code')).toBe(code);
    expect(target.searchParams.get('step_up_state')).toBe(started.state);
    expect(target.searchParams.has('access_token')).toBe(false);
    expect(
      await ctx.client.stepUpChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
      }),
    ).toMatchObject({ consumedAt: null });

    // The app completes it in the same session: an approval.
    const approval = data<Approval>(
      await completeGoogle(user, { code, state: started.state }).expect(201),
    );
    expect(approval).toMatchObject({
      action: 'ACCOUNT_DELETION',
      method: 'GOOGLE',
    });
    expect(
      await ctx.client.stepUpChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
      }),
    ).toMatchObject({ consumedAt: new Date(clock) });
    // Repeated: refused.
    expect(
      message(
        await completeGoogle(user, {
          code: googleCode(account),
          state: started.state,
        }).expect(403),
      ),
    ).toContain('already used');

    // Expired: refused.
    const late = data<{ state: string }>(
      await startGoogle(user, { action: 'ACCOUNT_DELETION' }).expect(201),
    );
    travel(10 * MINUTE);
    expect(
      message(
        await completeGoogle(user, {
          code: googleCode(account),
          state: late.state,
        }).expect(403),
      ),
    ).toContain('expired');

    // Another session of the same user: refused (and the challenge is used
    // up, so the right session cannot complete it afterwards either).
    const otherSession = await googleSignIn(account);
    const bound = data<{ state: string }>(
      await startGoogle(user, { action: 'ACCOUNT_DELETION' }).expect(201),
    );
    expect(
      message(
        await completeGoogle(otherSession, {
          code: googleCode(account),
          state: bound.state,
        }).expect(403),
      ),
    ).toContain('another session');
    await completeGoogle(user, {
      code: googleCode(account),
      state: bound.state,
    }).expect(403);
    // Another user: refused.
    const stranger = await googleSignIn(newGoogleAccount());
    const foreign = data<{ state: string }>(
      await startGoogle(user, { action: 'ACCOUNT_DELETION' }).expect(201),
    );
    await completeGoogle(stranger, {
      code: googleCode(account),
      state: foreign.state,
    }).expect(403);

    // A different Google identity than the account's: refused.
    const mismatch = data<{ state: string }>(
      await startGoogle(user, { action: 'ACCOUNT_DELETION' }).expect(201),
    );
    expect(
      message(
        await completeGoogle(user, {
          code: googleCode(newGoogleAccount()),
          state: mismatch.state,
        }).expect(403),
      ),
    ).toBe('The Google account does not match the signed-in user.');
    // Google refusing the code: refused.
    const refused = data<{ state: string }>(
      await startGoogle(user, { action: 'ACCOUNT_DELETION' }).expect(201),
    );
    await completeGoogle(user, {
      code: 'code-google-never-issued',
      state: refused.state,
    }).expect(403);
    // Only the one successful completion produced an approval.
    expect(await approvalRows(user.id)).toBe(1);
    expect(await approvalRows(stranger.id)).toBe(0);

    // The first approval is 10 minutes old by now: it no longer works.
    await sensitive(
      user,
      'post',
      '/v1/privacy/account-deletion',
      approval.approvalToken,
    )
      .send({ code: 'ABC123' })
      .expect(403);
    // A fresh one for the deletion, which also needs the emailed code.
    const fresh = data<{ state: string }>(
      await startGoogle(user, { action: 'ACCOUNT_DELETION' }).expect(201),
    );
    const deletionApproval = data<Approval>(
      await completeGoogle(user, {
        code: googleCode(account),
        state: fresh.state,
      }).expect(201),
    );
    jest.useRealTimers();
    await http()
      .post('/v1/privacy/account-deletion/confirmation-code')
      .set('Authorization', bearer(user.accessToken))
      .expect(202);
    const sent = await eventually(
      () =>
        Promise.resolve(
          ctx.emails.sent.find(
            (item) =>
              item.kind === 'account-deletion-code' &&
              item.to === account.email,
          ),
        ),
      30_000,
      'the account deletion code',
    );
    const accepted = await sensitive(
      user,
      'post',
      '/v1/privacy/account-deletion',
      deletionApproval.approvalToken,
    )
      .send({ code: sent.code })
      .expect(202);
    expect(data<{ status: string }>(accepted).status).toBe('PENDING');
  });

  it('lets an approved request through for every sensitive action', async () => {
    const user = await passwordAccount();
    const approval = async (action: StepUpAction) =>
      (await approve(user, action, { password: PASSWORD })).approvalToken;

    // Subscription: the request reaches the cancellation (this account has
    // no paid subscription, so there is nothing to cancel: 409, not 403).
    await sensitive(user, 'post', '/v1/subscription/cancel').expect(403);
    expect(
      message(
        await sensitive(
          user,
          'post',
          '/v1/subscription/cancel',
          await approval('SUBSCRIPTION_CANCEL'),
        ).expect(409),
      ),
    ).toBe('You do not have an active paid Pro subscription to cancel');

    // Export, then download link and archive (their own action).
    const exportApproval = await approval('PRIVACY_EXPORT');
    const requested = data<{ id: string }>(
      await sensitive(user, 'post', '/v1/privacy/exports', exportApproval)
        .set('Idempotency-Key', `export-${user.id}`)
        .expect(202),
    );
    await eventually(
      async () =>
        data<{ status: string }>(
          await http()
            .get(`/v1/privacy/exports/${requested.id}`)
            .set('Authorization', bearer(user.accessToken))
            .expect(200),
        ).status === 'COMPLETED',
      30_000,
      'the export',
    );
    const linkPath = `/v1/privacy/exports/${requested.id}/download`;
    await sensitive(user, 'get', linkPath, exportApproval).expect(403);
    const downloadApproval = await approval('PRIVACY_EXPORT_DOWNLOAD');
    const link = data<{ url: string }>(
      await sensitive(user, 'get', linkPath, downloadApproval).expect(200),
    );
    await sensitive(user, 'get', link.url).expect(403);
    const archive = await sensitive(user, 'get', link.url, downloadApproval)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((archive.body as Buffer).subarray(0, 2).toString('latin1')).toBe(
      'PK',
    );

    // MFA settings: enrollment start.
    await sensitive(
      user,
      'post',
      '/v1/auth/mfa/enrollment',
      await approval('MFA_SETTINGS'),
    ).expect(201);

    // Account deletion (password account: password, emailed code, approval).
    await http()
      .post('/v1/privacy/account-deletion/confirmation-code')
      .set('Authorization', bearer(user.accessToken))
      .expect(202);
    const sent = await eventually(
      () =>
        Promise.resolve(
          ctx.emails.sent.find(
            (item) =>
              item.kind === 'account-deletion-code' && item.to === user.email,
          ),
        ),
      30_000,
      'the account deletion code',
    );
    await sensitive(
      user,
      'post',
      '/v1/privacy/account-deletion',
      await approval('ACCOUNT_DELETION'),
    )
      .send({ password: PASSWORD, code: sent.code })
      .expect(202);
    expect(
      await ctx.client.authUser.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({ status: 'PENDING_DELETION' });
  });
});
