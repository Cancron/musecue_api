// Must be first: PostgreSQL-only infrastructure (REDIS_ENABLED=false, Redis
// unreachable) and test secrets, before any application module loads.
import './support/env-postgres-mode';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import {
  authenticatorCode,
  decryptStoredSecret,
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

jest.setTimeout(120_000);

/** Dedicated root key for authenticator secrets (MFA_ENCRYPTION_KEY). */
const MFA_KEY = 'mfa-enrollment-e2e-dedicated-key-0123456789';
const PASSWORD = 'correct horse battery staple';
const SECOND = 1_000;
const MINUTE = 60_000;
/** Stored secrets must look like this (and never like base32). */
const ENCRYPTED = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
}
interface StatusView {
  enabled: boolean;
  method: string | null;
  enabledAt: string | null;
  enrollment: {
    status: 'NONE' | 'PENDING' | 'EXPIRED' | 'BLOCKED';
    expiresAt: string | null;
    blockedUntil: string | null;
    remainingAttempts: number;
  } | null;
  recovery: { remainingCodes: number; generatedAt: string | null } | null;
  verification: {
    remainingAttempts: number;
    blockedUntil: string | null;
  } | null;
}
interface EnrollmentView {
  method: string;
  secret: string;
  otpauthUrl: string;
  issuer: string;
  accountName: string;
  algorithm: string;
  digits: number;
  period: number;
  expiresAt: string;
}
interface User {
  id: string;
  email: string;
  ip: string;
  accessToken: string;
}

const data = <T>(response: { body: unknown }) =>
  (response.body as Envelope<T>).data;
const message = (response: { body: unknown }) =>
  (response.body as { message: string }).message;

/**
 * Optional authenticator-app MFA through the real HTTP endpoints of the
 * complete application, on a temporary, freshly migrated PostgreSQL schema
 * (dropped afterwards): enrollment start, confirmation with a 6-digit code
 * valid for its 30-second step, the 10-minute enrollment expiry, refusal of
 * invalid, expired and reused codes, the block after 5 incorrect codes within
 * 15 minutes, owner-only access, and the switch of authSecurity.mfaEnabled
 * from false to true with mfaSecret stored encrypted.
 */
describeWithDatabase('MFA enrollment (e2e, PostgreSQL)', () => {
  let ctx: TestApplication;
  let ipCounter = 0;
  const originalKey = process.env.MFA_ENCRYPTION_KEY;

  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    process.env.MFA_ENCRYPTION_KEY = MFA_KEY;
    ctx = await bootApplication();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(async () => {
    await ctx?.close();
    if (originalKey === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = originalKey;
  });

  /** Registration, emailed verification code and password login over HTTP. */
  async function signUp(): Promise<User> {
    const tag = randomBytes(5).toString('hex');
    const email = `mfa_${tag}@example.com`;
    // Each user gets its own client address, so per-IP limits stay separate.
    ipCounter += 1;
    const ip = `203.0.113.${ipCounter}`;
    await http()
      .post('/auth')
      .set('X-Forwarded-For', ip)
      .send({ username: `mfa_${tag}`, email, password: PASSWORD })
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
    // Let the welcome email go out before any test freezes the clock.
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
    const user = { email, ip, id: '', accessToken: '' };
    await signIn(user);
    return user;
  }

  /** A fresh access token (they live 15 minutes). */
  async function signIn(user: User): Promise<void> {
    const login = data<{ accessToken: string; user: { id: string } }>(
      await http()
        .post('/auth/login')
        .set('X-Forwarded-For', user.ip)
        .send({ email: user.email, password: PASSWORD })
        .expect(201),
    );
    user.id = login.user.id;
    user.accessToken = login.accessToken;
  }

  const asUser = (user: User) => ({
    status: () =>
      http()
        .get('/v1/auth/mfa')
        .set('X-Forwarded-For', user.ip)
        .set('Authorization', `Bearer ${user.accessToken}`),
    start: (body?: object) => {
      const req = http()
        .post('/v1/auth/mfa/enrollment')
        .set('X-Forwarded-For', user.ip)
        .set('Authorization', `Bearer ${user.accessToken}`);
      return body ? req.send(body) : req;
    },
    confirm: (body: object) =>
      http()
        .post('/v1/auth/mfa/enrollment/confirm')
        .set('X-Forwarded-For', user.ip)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send(body),
  });

  const security = (authId: string) =>
    ctx.client.authSecurity.findUniqueOrThrow({ where: { authId } });
  const enrollmentRow = (authId: string) =>
    ctx.client.mfaEnrollment.findUnique({ where: { authId } });

  /** Freezes the clock (Date only; I/O and timers stay real) at `ms`. */
  let clock = 0;
  const travelTo = (ms: number) => {
    clock = ms;
    freezeTime(new Date(ms));
  };
  const travel = (ms: number) => travelTo(clock + ms);
  /** Starts the clock one second into a fresh 30-second TOTP step. */
  const startClock = () => travelTo(nextStepStart(Date.now()) + SECOND);

  it('enables MFA with a valid code within 30 seconds: authSecurity.mfaEnabled false -> true, mfaSecret encrypted', async () => {
    const user = await signUp();
    const api = asUser(user);

    // Before: MFA is disabled and no secret is stored.
    expect(await security(user.id)).toMatchObject({
      mfaEnabled: false,
      mfaMethod: null,
      mfaSecret: null,
      mfaEnabledAt: null,
    });
    const initial = await api.status().expect(200);
    expect(initial.headers['cache-control']).toBe('no-store');
    expect(data<StatusView>(initial)).toEqual({
      enabled: false,
      method: null,
      enabledAt: null,
      enrollment: {
        status: 'NONE',
        expiresAt: null,
        blockedUntil: null,
        remainingAttempts: 5,
      },
      recovery: null,
      verification: null,
    });

    startClock();
    const startedAt = clock;
    const started = await api.start().expect(201);
    expect(started.headers['cache-control']).toBe('no-store');
    const enrollment = data<EnrollmentView>(started);
    expect(enrollment).toMatchObject({
      method: 'totp',
      secret: expect.stringMatching(/^[A-Z2-7]{32}$/) as unknown,
      issuer: 'MuseCue',
      accountName: user.email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      expiresAt: new Date(startedAt + 10 * MINUTE).toISOString(),
    });
    const uri = new URL(enrollment.otpauthUrl);
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe(enrollment.secret);

    // Pending: the secret is stored only encrypted, MFA is still off.
    const pending = await enrollmentRow(user.id);
    expect(pending?.secret).toMatch(ENCRYPTED);
    expect(pending?.secret).not.toContain(enrollment.secret);
    expect(pending?.expiresAt).toEqual(new Date(startedAt + 10 * MINUTE));
    expect(
      decryptStoredSecret(pending!.secret!, MFA_KEY, user.id, 'enrollment'),
    ).toBe(enrollment.secret);
    expect(await security(user.id)).toMatchObject({
      mfaEnabled: false,
      mfaSecret: null,
    });
    expect(data<StatusView>(await api.status().expect(200))).toMatchObject({
      enabled: false,
      enrollment: {
        status: 'PENDING',
        expiresAt: new Date(startedAt + 10 * MINUTE).toISOString(),
      },
    });

    // The authenticator shows a code; it is entered 28 seconds later, still
    // inside its 30-second step.
    const code = authenticatorCode(enrollment.secret, clock);
    travel(28 * SECOND);
    const confirmedAt = clock;
    const confirmed = await api.confirm({ code }).expect(200);
    const { recoveryCodes, ...confirmedStatus } = data<
      StatusView & { recoveryCodes: string[] }
    >(confirmed);
    expect(confirmedStatus).toEqual({
      enabled: true,
      method: 'totp',
      enabledAt: new Date(confirmedAt).toISOString(),
      enrollment: null,
      recovery: {
        remainingCodes: 10,
        generatedAt: new Date(confirmedAt).toISOString(),
      },
      verification: { remainingAttempts: 5, blockedUntil: null },
    });
    // The one-time recovery codes (covered by test/mfa-recovery.e2e-spec.ts).
    expect(recoveryCodes).toHaveLength(10);

    // After: enabled, with the secret encrypted in authSecurity.mfaSecret.
    const after = await security(user.id);
    expect(after).toMatchObject({
      mfaEnabled: true,
      mfaMethod: 'totp',
      mfaEnabledAt: new Date(confirmedAt),
      mfaLastUsedStep: Math.floor(confirmedAt / 30_000),
    });
    expect(after.mfaSecret).toMatch(ENCRYPTED);
    expect(after.mfaSecret).not.toContain(enrollment.secret);
    expect(after.mfaSecret).not.toBe(pending?.secret);
    expect(
      decryptStoredSecret(after.mfaSecret!, MFA_KEY, user.id, 'active'),
    ).toBe(enrollment.secret);
    // Bound to this account and slot: it cannot be moved elsewhere.
    const other = await signUp();
    expect(() =>
      decryptStoredSecret(after.mfaSecret!, MFA_KEY, other.id, 'active'),
    ).toThrow();
    expect(() =>
      decryptStoredSecret(after.mfaSecret!, MFA_KEY, user.id, 'enrollment'),
    ).toThrow();
    // The pending enrollment is gone.
    expect(await enrollmentRow(user.id)).toBeNull();
    // No column anywhere holds the plaintext secret.
    const rows = await ctx.client.$queryRawUnsafe<unknown[]>(
      `SELECT * FROM "authSecurity" WHERE "authId" = $1`,
      user.id,
    );
    expect(JSON.stringify(rows)).not.toContain(enrollment.secret);
    // The database itself refuses a plaintext secret.
    await expect(
      ctx.client.authSecurity.update({
        where: { authId: user.id },
        data: { mfaSecret: enrollment.secret },
      }),
    ).rejects.toThrow(/authSecurity_mfaSecret_encrypted_check/);

    // Audited without the secret.
    const audit = await ctx.client.activityLogEvent.findFirstOrThrow({
      where: {
        recordId: user.id,
        details: { some: { fieldName: 'mfaEnabled' } },
      },
      include: { details: true },
    });
    expect(
      audit.details.map((d) => [d.fieldName, d.oldValue, d.newValue]),
    ).toEqual(
      expect.arrayContaining([
        ['mfaEnabled', 'false', 'true'],
        ['mfaMethod', null, 'totp'],
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain(enrollment.secret);

    expect(data<StatusView>(await api.status().expect(200))).toMatchObject({
      enabled: true,
      method: 'totp',
      enrollment: null,
    });

    // The used code cannot be used again, and MFA cannot be re-enrolled.
    expect(message(await api.confirm({ code }).expect(409))).toBe(
      'MFA is already enabled for this account',
    );
    await api.start().expect(409);
    expect((await security(user.id)).mfaSecret).toBe(after.mfaSecret);
  });

  it('rejects invalid and expired (older than 30 seconds) codes and counts them', async () => {
    const user = await signUp();
    const api = asUser(user);
    startClock();
    const { secret } = data<EnrollmentView>(await api.start().expect(201));

    const oldCode = authenticatorCode(secret, clock);
    // 30 seconds later the code's step is over.
    travel(30 * SECOND);
    if (oldCode !== authenticatorCode(secret, clock)) {
      expect(message(await api.confirm({ code: oldCode }).expect(400))).toBe(
        'Invalid or expired authentication code',
      );
    } else {
      // Two consecutive equal codes (1 in a million): count a wrong one instead.
      await api.confirm({ code: wrongCode(secret, clock) }).expect(400);
    }
    await api.confirm({ code: wrongCode(secret, clock) }).expect(400);

    // Malformed codes are rejected by validation and not counted.
    for (const code of ['12345', '1234567', 'abcdef', '12 345']) {
      await api.confirm({ code }).expect(400);
    }
    expect(data<StatusView>(await api.status().expect(200))).toMatchObject({
      enabled: false,
      enrollment: { status: 'PENDING', remainingAttempts: 3 },
    });
    expect(await enrollmentRow(user.id)).toMatchObject({ failedAttempts: 2 });
    expect((await security(user.id)).mfaEnabled).toBe(false);

    // The current code still confirms.
    await api.confirm({ code: authenticatorCode(secret, clock) }).expect(200);
    expect((await security(user.id)).mfaEnabled).toBe(true);
  });

  it('keeps an enrollment active for 10 minutes, then expires it', async () => {
    const user = await signUp();
    const api = asUser(user);
    startClock();
    const first = data<EnrollmentView>(await api.start().expect(201));

    // 10 minutes later the enrollment no longer accepts even a valid code.
    travel(10 * MINUTE);
    expect(
      message(
        await api
          .confirm({ code: authenticatorCode(first.secret, clock) })
          .expect(410),
      ),
    ).toBe('The MFA enrollment has expired. Start a new enrollment.');
    expect(data<StatusView>(await api.status().expect(200))).toMatchObject({
      enabled: false,
      // Not counted as an incorrect code.
      enrollment: { status: 'EXPIRED', remainingAttempts: 5 },
    });
    expect(await security(user.id)).toMatchObject({
      mfaEnabled: false,
      mfaSecret: null,
    });

    // A new enrollment gets a new secret; just before its 10 minutes end it
    // still works (the access token is renewed, it lives 15 minutes).
    const second = data<EnrollmentView>(await api.start().expect(201));
    expect(second.secret).not.toBe(first.secret);
    travel(10 * MINUTE - SECOND);
    await signIn(user);
    await api
      .confirm({ code: authenticatorCode(second.secret, clock) })
      .expect(200);
    expect(
      decryptStoredSecret(
        (await security(user.id)).mfaSecret!,
        MFA_KEY,
        user.id,
        'active',
      ),
    ).toBe(second.secret);
  });

  it('blocks enrollment after 5 incorrect codes within 15 minutes, even across restarts', async () => {
    const user = await signUp();
    const api = asUser(user);
    startClock();
    let { secret } = data<EnrollmentView>(await api.start().expect(201));

    for (let i = 0; i < 2; i += 1) {
      travel(SECOND);
      await api.confirm({ code: wrongCode(secret, clock) }).expect(400);
    }
    // Restarting the enrollment does not reset the counter.
    ({ secret } = data<EnrollmentView>(await api.start().expect(201)));
    for (let i = 0; i < 2; i += 1) {
      travel(SECOND);
      await api.confirm({ code: wrongCode(secret, clock) }).expect(400);
    }
    travel(SECOND);
    const blockedAt = clock;
    expect(
      message(
        await api.confirm({ code: wrongCode(secret, clock) }).expect(429),
      ),
    ).toBe(
      'Too many incorrect authentication codes. MFA enrollment is blocked; try again in 15 minutes.',
    );

    // Blocked: the right code and a new enrollment are refused too.
    await api.confirm({ code: authenticatorCode(secret, clock) }).expect(429);
    await api.start().expect(429);
    expect(data<StatusView>(await api.status().expect(200))).toMatchObject({
      enabled: false,
      enrollment: {
        status: 'BLOCKED',
        blockedUntil: new Date(blockedAt + 15 * MINUTE).toISOString(),
        remainingAttempts: 0,
      },
    });
    // The pending secret was discarded.
    expect(await enrollmentRow(user.id)).toMatchObject({
      secret: null,
      expiresAt: null,
      blockedUntil: new Date(blockedAt + 15 * MINUTE),
    });
    expect((await security(user.id)).mfaEnabled).toBe(false);

    travel(14 * MINUTE);
    await api.start().expect(429);

    // Once the block is over, a new enrollment can be completed.
    travelTo(blockedAt + 15 * MINUTE);
    await signIn(user);
    ({ secret } = data<EnrollmentView>(await api.start().expect(201)));
    expect(data<StatusView>(await api.status().expect(200))).toMatchObject({
      enrollment: { status: 'PENDING', remainingAttempts: 5 },
    });
    await api.confirm({ code: authenticatorCode(secret, clock) }).expect(200);
    expect((await security(user.id)).mfaEnabled).toBe(true);
  });

  it('does not block when the incorrect codes are spread over more than 15 minutes', async () => {
    const user = await signUp();
    const api = asUser(user);
    startClock();
    let { secret } = data<EnrollmentView>(await api.start().expect(201));
    for (let i = 0; i < 4; i += 1) {
      await api.confirm({ code: wrongCode(secret, clock) }).expect(400);
    }

    travel(15 * MINUTE);
    await signIn(user);
    ({ secret } = data<EnrollmentView>(await api.start().expect(201)));
    await api.confirm({ code: wrongCode(secret, clock) }).expect(400);
    expect(data<StatusView>(await api.status().expect(200))).toMatchObject({
      enrollment: { status: 'PENDING', remainingAttempts: 4 },
    });
    await api.confirm({ code: authenticatorCode(secret, clock) }).expect(200);
  });

  it('lets only the account owner manage the enrollment', async () => {
    const owner = await signUp();
    const intruder = await signUp();
    startClock();
    const { secret } = data<EnrollmentView>(
      await asUser(owner).start().expect(201),
    );
    const ownerRowBefore = await enrollmentRow(owner.id);

    // Without (or with an invalid) access token nothing is reachable.
    await http().get('/v1/auth/mfa').expect(401);
    await http().post('/v1/auth/mfa/enrollment').expect(401);
    await http()
      .post('/v1/auth/mfa/enrollment/confirm')
      .send({ code: authenticatorCode(secret, clock) })
      .expect(401);
    await http()
      .post('/v1/auth/mfa/enrollment/confirm')
      .set('Authorization', 'Bearer invalid')
      .send({ code: authenticatorCode(secret, clock) })
      .expect(401);

    // Another user cannot name the owner's account ...
    const named = await asUser(intruder)
      .confirm({ code: authenticatorCode(secret, clock), userId: owner.id })
      .expect(400);
    expect(message(named)).toContain('userId should not exist');
    await asUser(intruder).start({ userId: owner.id }).expect(400);
    // ... and the owner's valid code confirms nothing for them.
    await asUser(intruder)
      .confirm({ code: authenticatorCode(secret, clock) })
      .expect(404);
    expect(
      data<StatusView>(await asUser(intruder).status().expect(200)),
    ).toMatchObject({ enabled: false, enrollment: { status: 'NONE' } });

    // The owner's enrollment is untouched and still confirms.
    expect(await enrollmentRow(owner.id)).toEqual(ownerRowBefore);
    await asUser(owner)
      .confirm({ code: authenticatorCode(secret, clock) })
      .expect(200);
    expect((await security(owner.id)).mfaEnabled).toBe(true);
    expect((await security(intruder.id)).mfaEnabled).toBe(false);

    // Signing out everywhere revokes the owner's token for MFA routes too.
    await http()
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    await asUser(owner).status().expect(401);
  });

  it('confirms exactly once when the same code is submitted concurrently', async () => {
    const user = await signUp();
    const api = asUser(user);
    startClock();
    const { secret } = data<EnrollmentView>(await api.start().expect(201));
    const code = authenticatorCode(secret, clock);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => api.confirm({ code })),
    );

    expect(responses.map((r) => r.status).sort()).toEqual([
      200, 409, 409, 409, 409,
    ]);
    expect(
      await ctx.client.activityLogEvent.count({
        where: {
          recordId: user.id,
          details: { some: { fieldName: 'mfaEnabled' } },
        },
      }),
    ).toBe(1);
    expect(await security(user.id)).toMatchObject({
      mfaEnabled: true,
      mfaMethod: 'totp',
    });
  });
});
