// Must be first: PostgreSQL-only infrastructure (REDIS_ENABLED=false, Redis
// unreachable) and test secrets, before any application module loads.
import './support/env-postgres-mode';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import config from '../src/common/config/app.config';
import { authenticatorCode, nextStepStart } from './support/authenticator-app';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  eventually,
  type TestApplication,
} from './support/infrastructure-flows';
import { describeWithDatabase } from './support/migrated-schema';
import { STEP_UP_HEADER, stepUp } from './support/step-up';

jest.setTimeout(180_000);

const MFA_KEY = 'mfa-login-e2e-dedicated-key-0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const SECOND = 1_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const DEVICE_HEADER = 'X-Trusted-Device-Token';
const INVALID_CHALLENGE =
  'The MFA challenge is invalid or has expired. Please sign in again.';
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
interface Challenge {
  mfaRequired: true;
  challengeToken: string;
  challengeExpiresAt: string;
  methods: string[];
}
interface Completed extends Tokens {
  mfa: { method: string; remainingRecoveryCodes: number };
  trustedDevice: {
    id: string;
    token: string;
    name: string;
    expiresAt: string;
  } | null;
}
interface DeviceView {
  id: string;
  name: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  current: boolean;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
interface User {
  id: string;
  email: string;
  ip: string;
  accessToken: string;
}
interface MfaUser extends User {
  secret: string;
  codes: string[];
}

const data = <T>(response: { body: unknown }) =>
  (response.body as Envelope<T>).data;
const message = (response: { body: unknown }) =>
  (response.body as { message: string }).message;

/**
 * MFA as the second step of sign-in, through the real HTTP endpoints of the
 * complete application on a temporary, freshly migrated PostgreSQL schema
 * (dropped afterwards). Google is replaced by a fake of its token and
 * userinfo endpoints; everything else is real.
 */
describeWithDatabase('MFA at sign-in (e2e, PostgreSQL)', () => {
  let ctx: TestApplication;
  let ipCounter = 0;
  const originalEnv = {
    key: process.env.MFA_ENCRYPTION_KEY,
    googleId: process.env.GOOGLE_CLIENT_ID,
    googleSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirect: process.env.GOOGLE_REDIRECT_URI,
  };
  const realFetch = global.fetch;
  /** The Google accounts the fake Google knows, by authorization code. */
  const googleAccounts = new Map<string, { sub: string; email: string }>();

  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    process.env.MFA_ENCRYPTION_KEY = MFA_KEY;
    process.env.GOOGLE_CLIENT_ID = 'e2e-client.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'e2e-google-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost/auth/google/callback';
    // Google's token and userinfo endpoints (no ID token: the service then
    // reads the profile from userinfo). Every other request is real.
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
        const account = code ? googleAccounts.get(code) : undefined;
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
        const account = [...googleAccounts.values()].find(
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
    process.env.MFA_ENCRYPTION_KEY = MFA_KEY;
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
  /** Freezes the clock one second into a fresh 30-second TOTP step. */
  const startClock = () => travelTo(nextStepStart(Date.now()) + SECOND);
  /** Moves to the next TOTP step (each step's code is accepted once). */
  const nextStep = () => travelTo(nextStepStart(clock) + SECOND);

  const nextIp = () => {
    ipCounter += 1;
    return `192.0.2.${ipCounter}`;
  };

  /** Registration, emailed verification code and a first password login. */
  async function signUp(): Promise<User> {
    const tag = randomBytes(5).toString('hex');
    const email = `ml_${tag}@example.com`;
    const ip = nextIp();
    await http()
      .post('/auth')
      .set('X-Forwarded-For', ip)
      .send({ username: `ml_${tag}`, email, password: PASSWORD })
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
    const login = data<Tokens>(
      await http()
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password: PASSWORD })
        .expect(201),
    );
    return { id: login.user.id, email, ip, accessToken: login.accessToken };
  }

  const bearer = (token: string) => `Bearer ${token}`;

  /**
   * Enables MFA for a signed-in user (the clock must be frozen). Enrolling
   * needs a step-up approval: the password unless one is given (Google).
   */
  async function enableMfa<T extends User>(
    user: T,
    approval?: string,
  ): Promise<T & MfaUser> {
    const stepUpToken =
      approval ??
      (await stepUp(ctx.app.getHttpServer(), user, 'MFA_SETTINGS', {
        password: PASSWORD,
      }));
    const { secret } = data<{ secret: string }>(
      await http()
        .post('/v1/auth/mfa/enrollment')
        .set('X-Forwarded-For', user.ip)
        .set('Authorization', bearer(user.accessToken))
        .set(STEP_UP_HEADER, stepUpToken)
        .expect(201),
    );
    const { recoveryCodes } = data<{ recoveryCodes: string[] }>(
      await http()
        .post('/v1/auth/mfa/enrollment/confirm')
        .set('X-Forwarded-For', user.ip)
        .set('Authorization', bearer(user.accessToken))
        .set(STEP_UP_HEADER, stepUpToken)
        .send({ code: authenticatorCode(secret, clock) })
        .expect(200),
    );
    return { ...user, secret, codes: recoveryCodes };
  }

  async function mfaUser(): Promise<MfaUser> {
    const user = await signUp();
    startClock();
    const enabled = await enableMfa(user);
    // The enrollment code's step is used: sign-ins need a later code.
    nextStep();
    return enabled;
  }

  const login = (user: User, deviceToken?: string) => {
    const req = http()
      .post('/auth/login')
      .set('X-Forwarded-For', user.ip)
      .set('User-Agent', 'mfa-login-e2e/1.0');
    if (deviceToken) req.set(DEVICE_HEADER, deviceToken);
    return req.send({ email: user.email, password: PASSWORD });
  };
  const complete = (user: User, body: object) =>
    http()
      .post('/auth/mfa/challenge')
      .set('X-Forwarded-For', user.ip)
      .set('User-Agent', 'mfa-login-e2e/1.0')
      .send(body);
  /** Signs in with the password and expects a challenge (no tokens). */
  async function challengeFor(user: User, deviceToken?: string) {
    const response = await login(user, deviceToken).expect(201);
    const body = data<Challenge>(response);
    expect(body).not.toHaveProperty('accessToken');
    expect(body).not.toHaveProperty('refreshToken');
    expect(body.mfaRequired).toBe(true);
    return body;
  }
  const protectedCall = (token: string) =>
    http().get('/v1/auth/mfa').set('Authorization', bearer(token));
  const devices = (user: User, token: string, deviceToken?: string) => {
    const req = http()
      .get('/v1/auth/mfa/trusted-devices')
      .set('Authorization', bearer(token));
    if (deviceToken) req.set(DEVICE_HEADER, deviceToken);
    return req;
  };
  const sessionCount = (authId: string) =>
    ctx.client.refreshSession.count({ where: { authId } });

  /** A Google account the fake Google knows, with its own client address. */
  const googleAccount = () => {
    const sub = `google-${randomBytes(5).toString('hex')}`;
    return { sub, email: `${sub}@example.com`, ip: nextIp() };
  };
  type GoogleAccount = ReturnType<typeof googleAccount>;
  /** Google's authorization code for `account` (as after a Google login). */
  const googleCode = (account: GoogleAccount) => {
    const code = `code-${randomBytes(6).toString('hex')}`;
    googleAccounts.set(code, { sub: account.sub, email: account.email });
    return code;
  };
  /** GET /auth/google (optionally with the device header): the state. */
  async function googleStart(
    account: GoogleAccount,
    deviceToken?: string,
    redirectUrl?: string,
  ): Promise<string> {
    const req = http()
      .get('/auth/google')
      .query(redirectUrl ? { redirectUrl } : {})
      .set('X-Forwarded-For', account.ip);
    if (deviceToken) req.set(DEVICE_HEADER, deviceToken);
    return data<{ state: string }>(await req.expect(200)).state;
  }
  /** POST /auth/google/callback: the sign-in result (tokens or challenge). */
  async function googlePost(
    account: GoogleAccount,
    state: string,
    deviceToken?: string,
  ) {
    const req = http()
      .post('/auth/google/callback')
      .set('X-Forwarded-For', account.ip);
    if (deviceToken) req.set(DEVICE_HEADER, deviceToken);
    const response = await req
      .send({ code: googleCode(account), state })
      .expect(201);
    return data<{ data: Partial<Tokens & Challenge> }>(response).data;
  }
  /**
   * The browser flow: GET /auth/google (device header only here), then
   * Google's redirect to GET /auth/google/callback; returns where the
   * callback redirects the browser.
   */
  async function googleBrowser(account: GoogleAccount, deviceToken?: string) {
    const state = await googleStart(
      account,
      deviceToken,
      'https://app.example.com/done',
    );
    const response = await http()
      .get('/auth/google/callback')
      .query({ code: googleCode(account), state })
      .set('X-Forwarded-For', account.ip)
      .expect(302);
    return new URL(response.headers.location);
  }
  /**
   * Step-up through Google re-authentication (accounts without password
   * and MFA): start, Google's redirect (forwarded), completion.
   */
  async function googleStepUp(
    account: GoogleAccount,
    accessToken: string,
    action: string,
  ): Promise<string> {
    const { state } = data<{ state: string }>(
      await http()
        .post('/v1/auth/step-up/google')
        .set('Authorization', bearer(accessToken))
        .send({ action })
        .expect(201),
    );
    const approval = data<{ approvalToken: string; method: string }>(
      await http()
        .post('/v1/auth/step-up/google/callback')
        .set('Authorization', bearer(accessToken))
        .send({ code: googleCode(account), state })
        .expect(201),
    );
    expect(approval.method).toBe('GOOGLE');
    return approval.approvalToken;
  }

  // ------------------------------------------------------------------ tests

  it('signs in accounts without MFA exactly as before (tokens at once)', async () => {
    const user = await signUp();
    const before = await sessionCount(user.id);

    const response = await login(user).expect(201);
    const tokens = data<Tokens>(response);
    expect(tokens).toMatchObject({
      accessToken: expect.any(String) as unknown,
      refreshToken: expect.any(String) as unknown,
      user: { id: user.id, email: user.email },
    });
    expect(tokens).not.toHaveProperty('mfaRequired');
    await protectedCall(tokens.accessToken).expect(200);
    expect(await sessionCount(user.id)).toBe(before + 1);

    // A device header changes nothing for an account without MFA.
    const withHeader = data<Tokens>(
      await login(user, randomBytes(32).toString('base64url')).expect(201),
    );
    expect(withHeader.accessToken).toEqual(expect.any(String));
    expect(
      await ctx.client.mfaLoginChallenge.count({ where: { authId: user.id } }),
    ).toBe(0);
  });

  it('answers an MFA-enabled password sign-in with a challenge, and issues tokens only after a valid code', async () => {
    const user = await mfaUser();
    const sessionsBefore = await sessionCount(user.id);

    const challenge = await challengeFor(user);
    expect(challenge).toEqual({
      mfaRequired: true,
      challengeToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      challengeExpiresAt: new Date(clock + 5 * MINUTE).toISOString(),
      methods: ['totp', 'recovery_code'],
    });
    // No session was created; PostgreSQL holds only the challenge's hash.
    expect(await sessionCount(user.id)).toBe(sessionsBefore);
    const stored = await ctx.client.mfaLoginChallenge.findUniqueOrThrow({
      where: { tokenHash: sha256(challenge.challengeToken) },
    });
    expect(stored).toMatchObject({
      authId: user.id,
      provider: 'local',
      consumedAt: null,
      expiresAt: new Date(clock + 5 * MINUTE),
    });
    expect(JSON.stringify(stored)).not.toContain(challenge.challengeToken);
    expect(
      await ctx.client.loginHistory.findFirst({
        where: { authId: user.id, failureReason: 'mfa_required' },
      }),
    ).not.toBeNull();

    // The challenge token grants no access of any kind.
    await protectedCall(challenge.challengeToken).expect(401);
    await http()
      .get('/v1/profile')
      .set('Authorization', bearer(challenge.challengeToken))
      .expect(401);
    // Not a JWT: refused by validation before any lookup, no tokens.
    const asRefresh = await http()
      .post('/auth/refresh-token')
      .set('X-Forwarded-For', user.ip)
      .send({ refreshToken: challenge.challengeToken })
      .expect(400);
    expect(JSON.stringify(asRefresh.body)).not.toContain('accessToken');

    // A wrong code is refused (and counted); the challenge stays usable.
    const wrong =
      authenticatorCode(user.secret, clock) === '000000' ? '111111' : '000000';
    expect(
      message(
        await complete(user, {
          challengeToken: challenge.challengeToken,
          code: wrong,
        }).expect(400),
      ),
    ).toBe('Invalid or expired authentication code');
    // The challenge cannot be completed without a factor.
    await complete(user, { challengeToken: challenge.challengeToken }).expect(
      400,
    );

    const done = await complete(user, {
      challengeToken: challenge.challengeToken,
      code: authenticatorCode(user.secret, clock),
    }).expect(200);
    expect(done.headers['cache-control']).toBe('no-store');
    const tokens = data<Completed>(done);
    expect(tokens).toMatchObject({
      accessToken: expect.any(String) as unknown,
      refreshToken: expect.any(String) as unknown,
      user: { id: user.id, email: user.email },
      mfa: { method: 'totp', remainingRecoveryCodes: 10 },
      trustedDevice: null,
    });
    await protectedCall(tokens.accessToken).expect(200);
    // Exactly one session was created, now that MFA is satisfied ...
    expect(await sessionCount(user.id)).toBe(sessionsBefore + 1);
    // ... and its refresh token works like any other (rotation).
    await http()
      .post('/auth/refresh-token')
      .set('X-Forwarded-For', user.ip)
      .send({ refreshToken: tokens.refreshToken })
      .expect(201);
    expect(
      await ctx.client.mfaLoginChallenge.findUniqueOrThrow({
        where: { id: stored.id },
      }),
    ).toMatchObject({ consumedAt: new Date(clock) });
    expect(
      await ctx.client.authSecurity.findUniqueOrThrow({
        where: { authId: user.id },
      }),
    ).toMatchObject({ mfaFailedAttempts: 0 });

    // A used challenge never works again, even with a new valid code.
    nextStep();
    expect(
      message(
        await complete(user, {
          challengeToken: challenge.challengeToken,
          code: authenticatorCode(user.secret, clock),
        }).expect(401),
      ),
    ).toBe(INVALID_CHALLENGE);
  });

  it('accepts an unused recovery code instead of the authenticator, once', async () => {
    const user = await mfaUser();
    const first = await challengeFor(user);

    const done = data<Completed>(
      await complete(user, {
        challengeToken: first.challengeToken,
        recoveryCode: user.codes[0],
      }).expect(200),
    );
    expect(done.mfa).toEqual({
      method: 'recovery_code',
      remainingRecoveryCodes: 9,
    });
    await protectedCall(done.accessToken).expect(200);
    expect(
      await ctx.client.mfaRecoveryCode.count({
        where: { authId: user.id, usedAt: { not: null } },
      }),
    ).toBe(1);

    // The used code cannot complete another sign-in.
    const second = await challengeFor(user);
    await complete(user, {
      challengeToken: second.challengeToken,
      recoveryCode: user.codes[0],
    }).expect(400);
    await complete(user, {
      challengeToken: second.challengeToken,
      recoveryCode: user.codes[1],
    }).expect(200);
  });

  it('refuses an expired challenge (after 5 minutes) without consuming the code', async () => {
    const user = await mfaUser();
    const challenge = await challengeFor(user);

    travel(5 * MINUTE);
    expect(
      message(
        await complete(user, {
          challengeToken: challenge.challengeToken,
          recoveryCode: user.codes[0],
        }).expect(401),
      ),
    ).toBe(INVALID_CHALLENGE);
    // Neither the recovery code nor an incorrect attempt was recorded.
    expect(
      await ctx.client.mfaRecoveryCode.count({
        where: { authId: user.id, usedAt: { not: null } },
      }),
    ).toBe(0);
    expect(
      await ctx.client.authSecurity.findUniqueOrThrow({
        where: { authId: user.id },
      }),
    ).toMatchObject({ mfaFailedAttempts: 0 });
  });

  it('completes one challenge exactly once under concurrent requests', async () => {
    const user = await mfaUser();
    const challenge = await challengeFor(user);

    // Five requests, each with a different valid recovery code.
    const responses = await Promise.all(
      user.codes.slice(0, 5).map((code) =>
        complete(user, {
          challengeToken: challenge.challengeToken,
          recoveryCode: code,
        }),
      ),
    );

    expect(responses.map((r) => r.status).sort()).toEqual([
      200, 401, 401, 401, 401,
    ]);
    // Only the winner's code was consumed: the others were rolled back.
    expect(
      await ctx.client.mfaRecoveryCode.count({
        where: { authId: user.id, usedAt: { not: null } },
      }),
    ).toBe(1);
    expect(
      await ctx.client.refreshSession.count({
        where: { authId: user.id, revokedAt: null },
      }),
    ).toBe(2); // the sign-up login and the one MFA sign-in
  });

  it('trusts a device for 30 days: its sign-ins skip the challenge until the trust expires', async () => {
    const user = await mfaUser();
    const challenge = await challengeFor(user);
    const trustedAt = clock;

    const done = data<Completed>(
      await complete(user, {
        challengeToken: challenge.challengeToken,
        code: authenticatorCode(user.secret, clock),
        trustDevice: true,
        deviceName: 'Work laptop',
      }).expect(200),
    );
    const device = done.trustedDevice!;
    expect(device).toEqual({
      id: expect.any(String) as unknown,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      name: 'Work laptop',
      expiresAt: new Date(trustedAt + 30 * DAY).toISOString(),
    });
    // PostgreSQL: the owner's device, with only the token's hash.
    const row = await ctx.client.mfaTrustedDevice.findUniqueOrThrow({
      where: { id: device.id },
    });
    expect(row).toMatchObject({
      authId: user.id,
      tokenHash: sha256(device.token),
      name: 'Work laptop',
      userAgent: 'mfa-login-e2e/1.0',
      createdAt: new Date(trustedAt),
      expiresAt: new Date(trustedAt + 30 * DAY),
      revokedAt: null,
    });
    expect(JSON.stringify(row)).not.toContain(device.token);

    // With the device token: tokens at once, no challenge.
    travel(MINUTE);
    const skipped = data<Tokens>(await login(user, device.token).expect(201));
    expect(skipped).not.toHaveProperty('mfaRequired');
    await protectedCall(skipped.accessToken).expect(200);
    expect(
      await ctx.client.mfaTrustedDevice.findUniqueOrThrow({
        where: { id: device.id },
      }),
    ).toMatchObject({ lastUsedAt: new Date(clock) });
    // The device listing shows it (never the token), marked as current.
    const listed = await devices(
      user,
      skipped.accessToken,
      device.token,
    ).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(device.token);
    expect(data<DeviceView[]>(listed)).toEqual([
      expect.objectContaining({
        id: device.id,
        name: 'Work laptop',
        status: 'ACTIVE',
        current: true,
      }),
    ]);

    // Without it, or with any other token: the challenge. (Registration and
    // sign-ins share a limit of 5 per 15 minutes: start a new window.)
    travel(16 * MINUTE);
    await challengeFor(user);
    await challengeFor(user, randomBytes(32).toString('base64url'));

    // Still trusted one second before the 30 days end ...
    travelTo(trustedAt + 30 * DAY - SECOND);
    const lastDay = data<Tokens>(await login(user, device.token).expect(201));
    expect(lastDay.accessToken).toEqual(expect.any(String));
    // ... and no longer once they have passed.
    travelTo(trustedAt + 30 * DAY);
    await challengeFor(user, device.token);
    expect(
      data<DeviceView[]>(
        await devices(user, lastDay.accessToken).expect(200),
      )[0],
    ).toMatchObject({ id: device.id, status: 'EXPIRED' });
  });

  it('revokes a trusted device: its next sign-in needs MFA again', async () => {
    const user = await mfaUser();
    const challenge = await challengeFor(user);
    const done = data<Completed>(
      await complete(user, {
        challengeToken: challenge.challengeToken,
        code: authenticatorCode(user.secret, clock),
        trustDevice: true,
      }).expect(200),
    );
    const device = done.trustedDevice!;
    // Default name: the device's user agent.
    expect(device.name).toBe('mfa-login-e2e/1.0');

    // Revoking is an MFA settings change: it needs a step-up approval, even
    // on this trusted device (here with a recovery code).
    await http()
      .delete(`/v1/auth/mfa/trusted-devices/${device.id}`)
      .set('Authorization', bearer(done.accessToken))
      .set(DEVICE_HEADER, device.token)
      .expect(403);
    expect(
      await ctx.client.mfaTrustedDevice.findUniqueOrThrow({
        where: { id: device.id },
      }),
    ).toMatchObject({ revokedAt: null });
    const approval = await stepUp(
      ctx.app.getHttpServer(),
      { accessToken: done.accessToken, ip: user.ip },
      'MFA_SETTINGS',
      { recoveryCode: user.codes[0] },
    );
    const revoked = await http()
      .delete(`/v1/auth/mfa/trusted-devices/${device.id}`)
      .set('Authorization', bearer(done.accessToken))
      .set(STEP_UP_HEADER, approval)
      .expect(200);
    expect(data<DeviceView>(revoked)).toMatchObject({
      id: device.id,
      status: 'REVOKED',
      revokedAt: new Date(clock).toISOString(),
    });
    // Revoking again is harmless.
    await http()
      .delete(`/v1/auth/mfa/trusted-devices/${device.id}`)
      .set('Authorization', bearer(done.accessToken))
      .set(STEP_UP_HEADER, approval)
      .expect(200);

    await challengeFor(user, device.token);
    // PostgreSQL keeps the revocation, permanently.
    expect(
      await ctx.client.mfaTrustedDevice.findUniqueOrThrow({
        where: { id: device.id },
      }),
    ).toMatchObject({ revokedAt: new Date(clock) });
    await expect(
      ctx.client.$executeRawUnsafe(
        `UPDATE "MfaTrustedDevice" SET "revokedAt" = NULL WHERE "id" = $1`,
        device.id,
      ),
    ).rejects.toThrow(/cannot be restored/);
    await http()
      .delete('/v1/auth/mfa/trusted-devices/not-a-uuid')
      .set('Authorization', bearer(done.accessToken))
      .set(STEP_UP_HEADER, approval)
      .expect(400);
  });

  it('keeps challenges and trusted devices to their own account', async () => {
    const owner = await mfaUser();
    const ownerChallenge = await challengeFor(owner);
    const ownerDone = data<Completed>(
      await complete(owner, {
        challengeToken: ownerChallenge.challengeToken,
        code: authenticatorCode(owner.secret, clock),
        trustDevice: true,
      }).expect(200),
    );
    const ownerDevice = ownerDone.trustedDevice!;

    const other = await signUp();
    const otherMfa = await enableMfa(other);
    nextStep();

    // The owner's trusted device does not skip MFA for another account.
    const otherChallenge = await challengeFor(otherMfa, ownerDevice.token);
    // Another account's recovery code cannot complete the owner's challenge
    // (the challenge decides the account; nothing is issued to anyone).
    const ownerSecond = await challengeFor(owner);
    await complete(owner, {
      challengeToken: ownerSecond.challengeToken,
      recoveryCode: otherMfa.codes[0],
    }).expect(400);
    expect(
      await ctx.client.mfaRecoveryCode.count({
        where: { authId: other.id, usedAt: { not: null } },
      }),
    ).toBe(0);
    // A challenge completed with the right factor signs in its own account.
    const otherDone = data<Completed>(
      await complete(otherMfa, {
        challengeToken: otherChallenge.challengeToken,
        recoveryCode: otherMfa.codes[0],
      }).expect(200),
    );
    expect(otherDone.user.id).toBe(other.id);

    // Device management is owner-only.
    const otherList = data<DeviceView[]>(
      await devices(other, otherDone.accessToken, ownerDevice.token).expect(
        200,
      ),
    );
    expect(otherList).toEqual([]);
    // Even with its own step-up approval, another account cannot revoke it.
    const otherApproval = await stepUp(
      ctx.app.getHttpServer(),
      { accessToken: otherDone.accessToken, ip: other.ip },
      'MFA_SETTINGS',
      { recoveryCode: otherMfa.codes[1] },
    );
    await http()
      .delete(`/v1/auth/mfa/trusted-devices/${ownerDevice.id}`)
      .set('Authorization', bearer(otherDone.accessToken))
      .set(STEP_UP_HEADER, otherApproval)
      .expect(404);
    await http().get('/v1/auth/mfa/trusted-devices').expect(401);
    await http()
      .delete(`/v1/auth/mfa/trusted-devices/${ownerDevice.id}`)
      .expect(401);
    await http()
      .get('/v1/auth/mfa/trusted-devices')
      .set('Authorization', bearer(ownerChallenge.challengeToken))
      .expect(401);
    // The owner's device is untouched and still skips MFA for the owner.
    expect(
      await ctx.client.mfaTrustedDevice.findUniqueOrThrow({
        where: { id: ownerDevice.id },
      }),
    ).toMatchObject({ authId: owner.id, revokedAt: null });
    travel(16 * MINUTE); // past the 5-per-15-minutes login limit
    const skipped = data<Tokens>(
      await login(owner, ownerDevice.token).expect(201),
    );
    expect(skipped.user.id).toBe(owner.id);
  });

  it('applies the same MFA step to Google sign-in (JSON and redirect callbacks)', async () => {
    const sub = `google-${randomBytes(5).toString('hex')}`;
    const email = `${sub}@example.com`;
    const ip = nextIp();
    /** One Google sign-in: start (state) and POST callback (201). */
    const googleSignIn = async (deviceToken?: string) => {
      const start = await http()
        .get('/auth/google')
        .set('X-Forwarded-For', ip)
        .expect(200);
      const { state } = data<{ state: string }>(start);
      const code = `code-${randomBytes(6).toString('hex')}`;
      googleAccounts.set(code, { sub, email });
      const callback = http()
        .post('/auth/google/callback')
        .set('X-Forwarded-For', ip);
      if (deviceToken) callback.set(DEVICE_HEADER, deviceToken);
      return callback.send({ code, state }).expect(201);
    };
    const payloadOf = <T>(response: { body: unknown }) =>
      data<{ data: T }>(response).data;

    // First sign-in creates the account: tokens, no MFA yet.
    const created = payloadOf<Tokens & { isNewUser: boolean }>(
      await googleSignIn(),
    );
    expect(created.isNewUser).toBe(true);
    const user: User = {
      id: created.user.id,
      email,
      ip,
      accessToken: created.accessToken,
    };
    startClock();
    // No password and no MFA yet: enrolling is approved by re-authenticating
    // with Google.
    const enabled = await enableMfa(
      user,
      await googleStepUp({ sub, email, ip }, user.accessToken, 'MFA_SETTINGS'),
    );
    nextStep();

    // Now Google sign-in yields a challenge, not tokens.
    const challenged = await googleSignIn();
    expect(message(challenged)).toBe('Success');
    expect(data<{ message: string }>(challenged).message).toBe(
      'MFA verification required',
    );
    const challenge = payloadOf<Challenge & { isNewUser: boolean }>(challenged);
    expect(challenge).toMatchObject({ mfaRequired: true, isNewUser: false });
    expect(challenge).not.toHaveProperty('accessToken');
    expect(
      await ctx.client.mfaLoginChallenge.findUniqueOrThrow({
        where: { tokenHash: sha256(challenge.challengeToken) },
      }),
    ).toMatchObject({ authId: user.id, provider: 'google' });
    await protectedCall(challenge.challengeToken).expect(401);

    const done = data<Completed>(
      await complete(user, {
        challengeToken: challenge.challengeToken,
        code: authenticatorCode(enabled.secret, clock),
        trustDevice: true,
      }).expect(200),
    );
    expect(done.user.id).toBe(user.id);
    await protectedCall(done.accessToken).expect(200);

    // The browser flow redirects with the challenge only (no tokens) ...
    const redirectStart = await http()
      .get('/auth/google?redirectUrl=https://app.example.com/done')
      .set('X-Forwarded-For', ip)
      .expect(200);
    const redirectCode = `code-${randomBytes(6).toString('hex')}`;
    googleAccounts.set(redirectCode, { sub, email });
    const redirected = await http()
      .get('/auth/google/callback')
      .query({
        code: redirectCode,
        state: data<{ state: string }>(redirectStart).state,
      })
      .set('X-Forwarded-For', ip)
      .expect(302);
    const location = new URL(redirected.headers.location);
    expect(location.searchParams.get('mfa_required')).toBe('true');
    expect(location.searchParams.get('mfa_challenge_token')).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(location.searchParams.has('access_token')).toBe(false);
    expect(location.searchParams.has('refresh_token')).toBe(false);

    // ... unless the device is trusted: sent when starting the flow, it is
    // carried (encrypted) in the OAuth state to the redirect callback.
    const trustedStart = await http()
      .get('/auth/google?redirectUrl=https://app.example.com/done')
      .set('X-Forwarded-For', ip)
      .set(DEVICE_HEADER, done.trustedDevice!.token)
      .expect(200);
    const trustedCode = `code-${randomBytes(6).toString('hex')}`;
    googleAccounts.set(trustedCode, { sub, email });
    const trusted = await http()
      .get('/auth/google/callback')
      .query({
        code: trustedCode,
        state: data<{ state: string }>(trustedStart).state,
      })
      .set('X-Forwarded-For', ip)
      .expect(302);
    const trustedLocation = new URL(trusted.headers.location);
    expect(trustedLocation.searchParams.has('mfa_required')).toBe(false);
    await protectedCall(
      trustedLocation.searchParams.get('access_token') as string,
    ).expect(200);
    // And on the JSON callback via the header.
    const viaHeader = payloadOf<Tokens>(
      await googleSignIn(done.trustedDevice!.token),
    );
    await protectedCall(viaHeader.accessToken).expect(200);
  });

  it('skips the MFA challenge for a trusted device on every sign-in path (password, browser Google via the encrypted OAuth state, POST Google callback), and only then', async () => {
    // Password sign-in with a trusted device.
    const local = await mfaUser();
    const localChallenge = await challengeFor(local);
    const localDevice = data<Completed>(
      await complete(local, {
        challengeToken: localChallenge.challengeToken,
        code: authenticatorCode(local.secret, clock),
        trustDevice: true,
      }).expect(200),
    ).trustedDevice!;
    const viaPassword = data<Tokens>(
      await login(local, localDevice.token).expect(201),
    );
    expect(viaPassword).not.toHaveProperty('mfaRequired');
    await protectedCall(viaPassword.accessToken).expect(200);

    // A Google-only account with MFA and a trusted device.
    const account = googleAccount();
    const created = (await googlePost(
      account,
      await googleStart(account),
    )) as Tokens;
    const google = {
      id: created.user.id,
      email: account.email,
      ip: account.ip,
      accessToken: created.accessToken,
    };
    const enabled = await enableMfa(
      google,
      await googleStepUp(account, google.accessToken, 'MFA_SETTINGS'),
    );
    nextStep();
    const challenge = (await googlePost(
      account,
      await googleStart(account),
    )) as Challenge;
    expect(challenge.mfaRequired).toBe(true);
    const trusted = data<Completed>(
      await complete(google, {
        challengeToken: challenge.challengeToken,
        code: authenticatorCode(enabled.secret, clock),
        trustDevice: true,
      }).expect(200),
    );
    const device = trusted.trustedDevice!;

    // 1. Browser flow: the header is only sent when starting (GET
    //    /auth/google); the token travels encrypted in the OAuth state ...
    const browserState = await googleStart(
      account,
      device.token,
      'https://app.example.com/done',
    );
    const states = await ctx.client.oAuthState.findMany();
    expect(states.length).toBeGreaterThan(0);
    for (const row of states) {
      expect(row.payload).toMatch(
        /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );
      expect(row.payload).not.toContain(device.token);
      expect(row.stateHash).not.toContain(browserState);
    }
    // ... to Google's redirect (no header), which signs in without MFA.
    const redirected = await http()
      .get('/auth/google/callback')
      .query({ code: googleCode(account), state: browserState })
      .set('X-Forwarded-For', account.ip)
      .expect(302);
    const location = new URL(redirected.headers.location);
    expect(location.searchParams.has('mfa_required')).toBe(false);
    await protectedCall(location.searchParams.get('access_token')!).expect(200);
    expect(location.searchParams.get('user_id')).toBe(google.id);
    // 2. POST callback with the header.
    const viaHeader = (await googlePost(
      account,
      await googleStart(account),
      device.token,
    )) as Tokens;
    expect(viaHeader).not.toHaveProperty('mfaRequired');
    await protectedCall(viaHeader.accessToken).expect(200);
    // 3. POST callback with the token carried in the state (no header).
    const viaState = (await googlePost(
      account,
      await googleStart(account, device.token),
    )) as Tokens;
    expect(viaState).not.toHaveProperty('mfaRequired');
    await protectedCall(viaState.accessToken).expect(200);

    // Another account's trusted device skips nothing, on any path.
    expect(
      (await googleBrowser(account, localDevice.token)).searchParams.get(
        'mfa_required',
      ),
    ).toBe('true');
    expect(
      (await googlePost(account, await googleStart(account), localDevice.token))
        .mfaRequired,
    ).toBe(true);
    expect(
      (await googlePost(account, await googleStart(account, localDevice.token)))
        .mfaRequired,
    ).toBe(true);
    await challengeFor(local, device.token);

    // Trust ends exactly after 30 days, on the Google paths too.
    const trustedAt = new Date(device.expiresAt).getTime() - 30 * DAY;
    travelTo(trustedAt + 30 * DAY - SECOND);
    expect(
      (await googleBrowser(account, device.token)).searchParams.has(
        'access_token',
      ),
    ).toBe(true);
    travelTo(trustedAt + 30 * DAY);
    const expiredBrowser = await googleBrowser(account, device.token);
    expect(expiredBrowser.searchParams.get('mfa_required')).toBe('true');
    expect(expiredBrowser.searchParams.has('access_token')).toBe(false);
    expect(
      (await googlePost(account, await googleStart(account), device.token))
        .mfaRequired,
    ).toBe(true);

    // A revoked device skips nothing either (a new one, then revoked).
    nextStep();
    const again = (await googlePost(
      account,
      await googleStart(account),
    )) as Challenge;
    const second = data<Completed>(
      await complete(google, {
        challengeToken: again.challengeToken,
        code: authenticatorCode(enabled.secret, clock),
        trustDevice: true,
      }).expect(200),
    );
    const approval = await stepUp(
      ctx.app.getHttpServer(),
      { accessToken: second.accessToken, ip: account.ip },
      'MFA_SETTINGS',
      { recoveryCode: enabled.codes[0] },
    );
    await http()
      .delete(`/v1/auth/mfa/trusted-devices/${second.trustedDevice!.id}`)
      .set('Authorization', bearer(second.accessToken))
      .set(STEP_UP_HEADER, approval)
      .expect(200);
    const token = second.trustedDevice!.token;
    expect(
      (await googleBrowser(account, token)).searchParams.get('mfa_required'),
    ).toBe('true');
    expect(
      (await googlePost(account, await googleStart(account), token))
        .mfaRequired,
    ).toBe(true);
    expect(
      (await googlePost(account, await googleStart(account, token)))
        .mfaRequired,
    ).toBe(true);
  });

  it('keeps MFA working when the JWT secrets rotate, and fails closed without MFA_ENCRYPTION_KEY', async () => {
    const user = await mfaUser();
    const originalSecrets = {
      refresh: config.jwt_refresh_secret,
      access: config.jwt_access_secret,
    };
    try {
      // Rotate both JWT secrets after MFA was enabled.
      config.jwt_refresh_secret = 'rotated-refresh-secret-0123456789abcdef';
      config.jwt_access_secret = 'rotated-access-secret-0123456789abcdef';

      const first = await challengeFor(user);
      const viaTotp = data<Completed>(
        await complete(user, {
          challengeToken: first.challengeToken,
          code: authenticatorCode(user.secret, clock),
        }).expect(200),
      );
      await protectedCall(viaTotp.accessToken).expect(200);
      const second = await challengeFor(user);
      await complete(user, {
        challengeToken: second.challengeToken,
        recoveryCode: user.codes[0],
      }).expect(200);

      // Without MFA_ENCRYPTION_KEY nothing falls back: the sign-in still
      // stops at the challenge and completing it is unavailable (503).
      process.env.MFA_ENCRYPTION_KEY = '';
      nextStep();
      const third = await challengeFor(user);
      expect(
        message(
          await complete(user, {
            challengeToken: third.challengeToken,
            code: authenticatorCode(user.secret, clock),
          }).expect(503),
        ),
      ).toBe('MFA is temporarily unavailable');
      await complete(user, {
        challengeToken: third.challengeToken,
        recoveryCode: user.codes[1],
      }).expect(503);
      // Nothing was consumed; with the key back the same challenge works.
      process.env.MFA_ENCRYPTION_KEY = MFA_KEY;
      await complete(user, {
        challengeToken: third.challengeToken,
        recoveryCode: user.codes[1],
      }).expect(200);
    } finally {
      config.jwt_refresh_secret = originalSecrets.refresh;
      config.jwt_access_secret = originalSecrets.access;
    }
  });
});
