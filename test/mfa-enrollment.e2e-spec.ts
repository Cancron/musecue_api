// Must be first: fixes the environment (REDIS_ENABLED=false, secrets) before
// any application module reads it. MFA state is PostgreSQL-only, so this is
// the mode that matters; HTTP contracts are the same with Redis.
import './support/env-postgres-mode';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { decryptMfaSecret } from '../src/auth/mfa/mfa-secret.cipher';
import { totpCode, totpStep } from '../src/auth/mfa/mfa-totp';
import type {
  MfaEnrollmentStartView,
  MfaStatusView,
} from '../src/auth/mfa/mfa.service';
import { AuthStateCleanupService } from '../src/auth/state/auth-state-cleanup.service';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  type TestApplication,
} from './support/infrastructure-flows';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(120_000);

const PASSWORD = 'correct horse battery staple';
const SECOND = 1000;
const MIN = 60 * SECOND;

interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
}
const dataOf = <T>(response: { body: unknown }) =>
  (response.body as Envelope<T>).data;
const messageOf = (response: { body: unknown }) =>
  (response.body as { message: string }).message;

/** A six-digit code that is certainly not `code`. */
const wrongCode = (code: string) =>
  String((Number(code) + 1) % 1_000_000).padStart(6, '0');

interface TestUser {
  id: string;
  email: string;
  ip: string;
  accessToken: string;
}

/**
 * Optional MFA (authenticator app) through the real endpoints of the whole
 * application on a temporary, freshly migrated PostgreSQL schema: users are
 * temporary rows, sign in with POST /auth/login, and manage their MFA
 * enrollment over HTTP. The clock is frozen (timers stay real) so the
 * 30-second code, 10-minute enrollment and 15-minute lockout rules can be
 * checked exactly.
 */
describeWithDatabase('MFA enrollment (e2e, PostgreSQL)', () => {
  let ctx: TestApplication;
  let passwordHash: string;
  /** The frozen application time; only ever moves forward. */
  let clock: Date;
  let ipCounter = 0;

  const http = () => request(ctx.app.getHttpServer());
  const setClock = (to: Date) => {
    clock = to;
    jest.setSystemTime(clock);
  };
  const advance = (ms: number) => setClock(new Date(clock.getTime() + ms));
  /** Moves to the start of a later 30-second TOTP step. */
  const nextStepStart = (afterMs = 0) =>
    setClock(
      new Date((Math.floor((clock.getTime() + afterMs) / 30_000) + 1) * 30_000),
    );

  beforeAll(async () => {
    ctx = await bootApplication();
    passwordHash = await bcrypt.hash(PASSWORD, 4);
    clock = new Date();
    freezeTime(clock);
    // Start on a step boundary, so every test controls the position in it.
    nextStepStart();
  });

  afterAll(async () => {
    jest.useRealTimers();
    await ctx?.close();
  });

  beforeEach(() => {
    // Every test runs well after the previous one (throttling windows,
    // enrollments and blocks of earlier tests are over).
    nextStepStart(60 * MIN);
  });

  /** A verified local account (temporary row) signed in through the API. */
  async function createUser(): Promise<TestUser> {
    const tag = randomBytes(5).toString('hex');
    const email = `mfa_${tag}@example.com`;
    const user = await ctx.client.authUser.create({
      data: {
        email,
        username: `mfa_${tag}`,
        password: passwordHash,
        verified: true,
        authSecurity: { create: { mfaEnabled: false } },
      },
    });
    const ip = `198.18.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
    const testUser = { id: user.id, email, ip, accessToken: '' };
    await signIn(testUser);
    return testUser;
  }

  /** (Re-)signs in at the current time: access tokens live 15 minutes. */
  async function signIn(user: TestUser) {
    const response = await http()
      .post('/auth/login')
      .set('X-Forwarded-For', user.ip)
      .send({ email: user.email, password: PASSWORD })
      .expect(201);
    user.accessToken = dataOf<{ accessToken: string }>(response).accessToken;
  }

  const as = (user: TestUser) => ({
    Authorization: `Bearer ${user.accessToken}`,
    'X-Forwarded-For': user.ip,
  });
  const getStatus = (user: TestUser) => http().get('/auth/mfa').set(as(user));
  const start = (user: TestUser) =>
    http().post('/auth/mfa/enrollment').set(as(user));
  const confirm = (user: TestUser, code: string) =>
    http().post('/auth/mfa/enrollment/confirm').set(as(user)).send({ code });
  const startOk = async (user: TestUser) =>
    dataOf<MfaEnrollmentStartView>(await start(user).expect(201));

  const securityOf = (user: TestUser) =>
    ctx.client.authSecurity.findUniqueOrThrow({ where: { authId: user.id } });
  const enrollmentOf = (user: TestUser) =>
    ctx.client.mfaEnrollment.findUnique({ where: { authId: user.id } });

  it('enables MFA: mfaEnabled false -> true, with mfaSecret stored encrypted', async () => {
    const user = await createUser();

    // Before: MFA is off, nothing is stored.
    expect(await securityOf(user)).toMatchObject({
      mfaEnabled: false,
      mfaMethod: null,
      mfaSecret: null,
      mfaLastUsedStep: null,
    });
    expect(dataOf<MfaStatusView>(await getStatus(user).expect(200))).toEqual({
      enabled: false,
      method: null,
      enrollment: {
        status: 'NONE',
        expiresAt: null,
        blockedUntil: null,
        remainingAttempts: 5,
      },
    });

    // Start: a secret for the authenticator app, valid for 10 minutes.
    const startResponse = await start(user).expect(201);
    expect(startResponse.headers['cache-control']).toBe('no-store');
    const started = dataOf<MfaEnrollmentStartView>(startResponse);
    expect(started).toEqual({
      secret: expect.stringMatching(/^[A-Z2-7]{32}$/) as string,
      otpauthUrl: expect.stringMatching(
        /^otpauth:\/\/totp\/MuseCue:/,
      ) as string,
      issuer: 'MuseCue',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      expiresAt: new Date(clock.getTime() + 10 * MIN).toISOString(),
    });
    const pending = await enrollmentOf(user);
    expect(pending!.expiresAt).toEqual(new Date(clock.getTime() + 10 * MIN));
    // The pending secret is encrypted and bound to this user.
    expect(pending!.secret).toMatch(/^v1\./);
    expect(pending!.secret).not.toContain(started.secret);
    expect(decryptMfaSecret('enrollment', user.id, pending!.secret!)).toBe(
      started.secret,
    );
    expect(dataOf<MfaStatusView>(await getStatus(user)).enrollment).toEqual({
      status: 'PENDING',
      expiresAt: started.expiresAt,
      blockedUntil: null,
      remainingAttempts: 5,
    });
    // Starting changes nothing on the account yet.
    expect(await securityOf(user)).toMatchObject({
      mfaEnabled: false,
      mfaSecret: null,
    });

    // Confirm with the app's current code, 20 seconds into its step.
    advance(20 * SECOND);
    const code = totpCode(started.secret, clock);
    const confirmed = await confirm(user, code).expect(200);
    expect(dataOf<MfaStatusView>(confirmed)).toMatchObject({
      enabled: true,
      method: 'totp',
    });

    // After: enabled, and the secret is stored only encrypted.
    const security = await securityOf(user);
    expect(security).toMatchObject({
      mfaEnabled: true,
      mfaMethod: 'totp',
      mfaLastUsedStep: totpStep(clock),
    });
    expect(security.mfaSecret).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    const raw = security.mfaSecret!;
    expect(raw).not.toContain(started.secret);
    expect(raw.toLowerCase()).not.toContain(started.secret.toLowerCase());
    expect(decryptMfaSecret('confirmed', user.id, raw)).toBe(started.secret);
    // Bound to this account: it cannot be decrypted for any other.
    expect(() => decryptMfaSecret('confirmed', 'someone-else', raw)).toThrow();
    // No plaintext copy is left in the enrollment table.
    expect(await enrollmentOf(user)).toBeNull();
    // Checked at the SQL level too: no column of the user's MFA rows holds
    // the secret.
    const rows = await ctx.client.$queryRaw<{ row: string }[]>`
      SELECT row_to_json(s)::text AS row FROM "authSecurity" s
      WHERE s."authId" = ${user.id}
      UNION ALL
      SELECT row_to_json(e)::text FROM "MfaEnrollment" e
      WHERE e."authId" = ${user.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].row).not.toContain(started.secret);

    // The change is audited, without the secret.
    const audit = await ctx.client.activityLogEvent.findFirstOrThrow({
      where: { tableName: 'authUser', recordId: user.id, eventType: 'update' },
      include: { details: true },
    });
    expect(audit.actionedBy).toBe(user.id);
    expect(
      audit.details.map(({ fieldName, oldValue, newValue }) => ({
        fieldName,
        oldValue,
        newValue,
      })),
    ).toEqual(
      expect.arrayContaining([
        { fieldName: 'mfaEnabled', oldValue: 'false', newValue: 'true' },
        { fieldName: 'mfaMethod', oldValue: null, newValue: 'totp' },
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain(started.secret);

    // The status endpoint reports it.
    expect(dataOf<MfaStatusView>(await getStatus(user).expect(200))).toEqual({
      enabled: true,
      method: 'totp',
      enrollment: {
        status: 'NONE',
        expiresAt: null,
        blockedUntil: null,
        remainingAttempts: 5,
      },
    });
  });

  it('never accepts an already used code again', async () => {
    const user = await createUser();
    const { secret } = await startOk(user);
    const code = totpCode(secret, clock);
    await confirm(user, code).expect(200);
    const enabled = await securityOf(user);

    // Replayed within the same 30 seconds, and later.
    advance(5 * SECOND);
    expect(messageOf(await confirm(user, code).expect(409))).toBe(
      'MFA is already enabled for this account',
    );
    // A new enrollment cannot be started to reuse it either.
    await start(user).expect(409);
    expect(await securityOf(user)).toEqual(enabled);
    expect(
      await ctx.client.activityLogEvent.count({
        where: {
          tableName: 'authUser',
          recordId: user.id,
          eventType: 'update',
        },
      }),
    ).toBe(1);
  });

  it('accepts exactly one of concurrent confirmations with the same code', async () => {
    const user = await createUser();
    const { secret } = await startOk(user);
    const code = totpCode(secret, clock);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => confirm(user, code)),
    );

    expect(responses.map((r) => r.status).sort()).toEqual([
      200, 409, 409, 409, 409,
    ]);
    expect((await securityOf(user)).mfaEnabled).toBe(true);
    expect(
      await ctx.client.activityLogEvent.count({
        where: {
          tableName: 'authUser',
          recordId: user.id,
          eventType: 'update',
        },
      }),
    ).toBe(1);
  });

  describe('30-second code validity', () => {
    it('accepts a code until the last second of its 30-second step', async () => {
      const user = await createUser();
      const { secret } = await startOk(user);
      const code = totpCode(secret, clock);

      advance(29 * SECOND + 999);
      await confirm(user, code).expect(200);
      expect((await securityOf(user)).mfaEnabled).toBe(true);
    });

    it('rejects an expired code (after its 30 seconds) and counts it', async () => {
      const user = await createUser();
      const { secret } = await startOk(user);
      const code = totpCode(secret, clock);

      advance(30 * SECOND);
      const response = await confirm(user, code).expect(400);
      expect(messageOf(response)).toBe(
        'Invalid or expired authenticator code. 4 attempt(s) remaining.',
      );
      advance(45 * SECOND);
      await confirm(user, code).expect(400);

      expect(await securityOf(user)).toMatchObject({
        mfaEnabled: false,
        mfaSecret: null,
      });
      expect((await enrollmentOf(user))!.failedAttemptsAt).toHaveLength(2);
      // The app's current code still works.
      await confirm(user, totpCode(secret, clock)).expect(200);
    });

    it('rejects an invalid code and keeps the enrollment pending', async () => {
      const user = await createUser();
      const { secret } = await startOk(user);

      await confirm(user, wrongCode(totpCode(secret, clock))).expect(400);

      expect((await securityOf(user)).mfaEnabled).toBe(false);
      expect(dataOf<MfaStatusView>(await getStatus(user)).enrollment).toEqual(
        expect.objectContaining({ status: 'PENDING', remainingAttempts: 4 }),
      );
    });

    it.each([
      ['five digits', { code: '12345' }],
      ['letters', { code: 'abcdef' }],
      ['a number', { code: 123456 }],
      ['no code', {}],
    ])(
      'rejects %s as a validation error without counting it',
      async (_, body) => {
        const user = await createUser();
        await startOk(user);

        await http()
          .post('/auth/mfa/enrollment/confirm')
          .set(as(user))
          .send(body)
          .expect(400);

        expect((await enrollmentOf(user))!.failedAttemptsAt).toEqual([]);
      },
    );
  });

  describe('10-minute enrollment', () => {
    it('stays confirmable until it expires after 10 minutes', async () => {
      const user = await createUser();
      const { secret } = await startOk(user);

      advance(10 * MIN - 5 * SECOND);
      await signIn(user); // the 15-minute access token is still fine; renew anyway
      await confirm(user, totpCode(secret, clock)).expect(200);
      expect((await securityOf(user)).mfaEnabled).toBe(true);
    });

    it('expires after 10 minutes: a valid code is refused and the secret forgotten', async () => {
      const user = await createUser();
      const { secret } = await startOk(user);

      advance(10 * MIN);
      expect(
        dataOf<MfaStatusView>(await getStatus(user)).enrollment.status,
      ).toBe('EXPIRED');
      const response = await confirm(user, totpCode(secret, clock)).expect(410);
      expect(messageOf(response)).toBe(
        'The MFA enrollment has expired. Start a new enrollment.',
      );

      expect(await securityOf(user)).toMatchObject({
        mfaEnabled: false,
        mfaSecret: null,
      });
      expect(await enrollmentOf(user)).toMatchObject({
        secret: null,
        expiresAt: null,
      });
      await confirm(user, totpCode(secret, clock)).expect(409);

      // A new enrollment, with a new secret, works.
      const restarted = await startOk(user);
      expect(restarted.secret).not.toBe(secret);
      await confirm(user, totpCode(restarted.secret, clock)).expect(200);
    });

    it('is replaced by a restart: only the newest secret works', async () => {
      const user = await createUser();
      const first = await startOk(user);
      advance(2 * MIN);
      const second = await startOk(user);

      await confirm(user, totpCode(first.secret, clock)).expect(400);
      await confirm(user, totpCode(second.secret, clock)).expect(200);
    });

    it('is cleaned up by the expiry sweep', async () => {
      const expired = await createUser();
      const failed = await createUser();
      const active = await createUser();
      const { secret } = await startOk(expired);
      const failedStart = await startOk(failed);
      await confirm(
        failed,
        wrongCode(totpCode(failedStart.secret, clock)),
      ).expect(400);
      advance(5 * MIN);
      await startOk(active);

      // 10 minutes after the first two started: their secrets are expired,
      // but the failure of `failed` still counts for another 5 minutes.
      advance(5 * MIN);
      const sweeper = ctx.get<AuthStateCleanupService>(AuthStateCleanupService);
      await sweeper.sweep(clock);

      expect(await enrollmentOf(expired)).toBeNull();
      expect(await enrollmentOf(failed)).toMatchObject({
        secret: null,
        expiresAt: null,
      });
      expect((await enrollmentOf(failed))!.failedAttemptsAt).toHaveLength(1);
      expect((await enrollmentOf(active))!.secret).not.toBeNull();

      // Once the failure is older than 15 minutes, the row goes too.
      advance(5 * MIN + SECOND);
      await sweeper.sweep(clock);
      expect(await enrollmentOf(failed)).toBeNull();
      await signIn(expired);
      await confirm(expired, totpCode(secret, clock)).expect(409);
    });
  });

  describe('lockout: 5 incorrect codes in 15 minutes', () => {
    it('blocks the enrollment temporarily, then allows a new one', async () => {
      const user = await createUser();
      const { secret } = await startOk(user);

      const responses: request.Response[] = [];
      for (let i = 0; i < 5; i++) {
        responses.push(await confirm(user, wrongCode(totpCode(secret, clock))));
        advance(MIN);
      }

      expect(responses.map((r) => r.status)).toEqual([400, 400, 400, 400, 429]);
      expect(responses.slice(0, 4).map(messageOf)).toEqual([
        'Invalid or expired authenticator code. 4 attempt(s) remaining.',
        'Invalid or expired authenticator code. 3 attempt(s) remaining.',
        'Invalid or expired authenticator code. 2 attempt(s) remaining.',
        'Invalid or expired authenticator code. 1 attempt(s) remaining.',
      ]);
      // The fifth failure happened 4 minutes after the first (the clock has
      // since moved one more minute): blocked for 15 minutes from then.
      const blockedUntil = new Date(clock.getTime() - MIN + 15 * MIN);
      expect(messageOf(responses[4])).toBe(
        `Too many incorrect codes. MFA enrollment is blocked until ${blockedUntil.toISOString()}.`,
      );
      expect(await enrollmentOf(user)).toMatchObject({
        secret: null,
        expiresAt: null,
        failedAttemptsAt: [],
        blockedUntil,
      });
      expect(dataOf<MfaStatusView>(await getStatus(user)).enrollment).toEqual({
        status: 'BLOCKED',
        expiresAt: null,
        blockedUntil: blockedUntil.toISOString(),
        remainingAttempts: 0,
      });

      // While blocked: even the correct code and a restart are refused, and
      // nothing extends the block.
      await confirm(user, totpCode(secret, clock)).expect(429);
      await start(user).expect(429);
      expect((await enrollmentOf(user))!.blockedUntil).toEqual(blockedUntil);
      expect((await securityOf(user)).mfaEnabled).toBe(false);

      // After the block: a fresh enrollment succeeds.
      setClock(blockedUntil);
      await signIn(user);
      const fresh = await startOk(user);
      expect(fresh.secret).not.toBe(secret);
      await confirm(user, totpCode(fresh.secret, clock)).expect(200);
      expect(await securityOf(user)).toMatchObject({
        mfaEnabled: true,
        mfaMethod: 'totp',
      });
    });

    it('is not reset by restarting the enrollment', async () => {
      const user = await createUser();
      const first = await startOk(user);
      for (let i = 0; i < 3; i++) {
        await confirm(user, wrongCode(totpCode(first.secret, clock))).expect(
          400,
        );
      }
      const second = await startOk(user);
      await confirm(user, wrongCode(totpCode(second.secret, clock))).expect(
        400,
      );
      await confirm(user, wrongCode(totpCode(second.secret, clock))).expect(
        429,
      );
    });

    it('only counts incorrect codes of the last 15 minutes', async () => {
      const user = await createUser();
      const { secret } = await startOk(user);
      for (let i = 0; i < 4; i++) {
        await confirm(user, wrongCode(totpCode(secret, clock))).expect(400);
      }

      advance(15 * MIN);
      await signIn(user);
      const restarted = await startOk(user);
      const response = await confirm(
        user,
        wrongCode(totpCode(restarted.secret, clock)),
      ).expect(400);
      expect(messageOf(response)).toContain('4 attempt(s) remaining');
    });
  });

  describe('only the account owner manages its MFA', () => {
    it('requires a valid access token', async () => {
      await http().get('/auth/mfa').expect(401);
      await http().post('/auth/mfa/enrollment').expect(401);
      await http()
        .post('/auth/mfa/enrollment/confirm')
        .send({ code: '123456' })
        .expect(401);
      await http()
        .get('/auth/mfa')
        .set('Authorization', 'Bearer not-a-token')
        .expect(401);
    });

    it("cannot read, start or confirm another user's enrollment", async () => {
      const alice = await createUser();
      const bob = await createUser();
      const { secret } = await startOk(alice);
      const aliceBefore = await enrollmentOf(alice);

      // Nothing can name Alice: bodies with a user ID are rejected...
      await http()
        .post('/auth/mfa/enrollment')
        .set(as(bob))
        .send({ userId: alice.id })
        .expect(400);
      await http()
        .post('/auth/mfa/enrollment/confirm')
        .set(as(bob))
        .send({ code: totpCode(secret, clock), userId: alice.id })
        .expect(400);
      // ...and query parameters are ignored: Bob only ever sees himself.
      const bobStatus = await http()
        .get(`/auth/mfa?userId=${alice.id}`)
        .set(as(bob))
        .expect(200);
      expect(dataOf<MfaStatusView>(bobStatus).enrollment.status).toBe('NONE');

      // Alice's code confirms nothing for Bob.
      await confirm(bob, totpCode(secret, clock)).expect(409);
      await startOk(bob);
      await confirm(bob, totpCode(secret, clock)).expect(400);

      expect(await securityOf(bob)).toMatchObject({
        mfaEnabled: false,
        mfaSecret: null,
      });
      expect(await securityOf(alice)).toMatchObject({
        mfaEnabled: false,
        mfaSecret: null,
      });
      expect(await enrollmentOf(alice)).toEqual(aliceBefore);

      // Alice herself still can.
      await confirm(alice, totpCode(secret, clock)).expect(200);
      expect((await securityOf(alice)).mfaEnabled).toBe(true);
      expect((await securityOf(bob)).mfaEnabled).toBe(false);
    });

    it("does not let Bob's failures block Alice", async () => {
      const alice = await createUser();
      const bob = await createUser();
      const bobStart = await startOk(bob);
      for (let i = 0; i < 5; i++) {
        await confirm(bob, wrongCode(totpCode(bobStart.secret, clock))).expect(
          i < 4 ? 400 : 429,
        );
      }
      await start(bob).expect(429);

      const { secret } = await startOk(alice);
      await confirm(alice, totpCode(secret, clock)).expect(200);
    });

    it('stops working for tokens revoked by logout-all', async () => {
      const user = await createUser();
      const revoked = { ...user };
      await http().post('/auth/logout-all').set(as(user)).expect(201);

      await start(revoked).expect(401);
      expect(await enrollmentOf(user)).toBeNull();
    });
  });

  it('removes the enrollment with the account (cascade)', async () => {
    const user = await createUser();
    await startOk(user);

    await ctx.client.authUser.delete({ where: { id: user.id } });

    expect(await enrollmentOf(user)).toBeNull();
  });

  it('enforces the enrollment rules in the database', async () => {
    const user = await createUser();
    // A pending secret always has its expiry.
    await expect(
      ctx.client.mfaEnrollment.create({
        data: { authId: user.id, secret: 'v1.a.b.c' },
      }),
    ).rejects.toThrow();
    // At most five failures are stored.
    await expect(
      ctx.client.mfaEnrollment.create({
        data: {
          authId: user.id,
          failedAttemptsAt: Array.from({ length: 6 }, () => clock),
        },
      }),
    ).rejects.toThrow();
    // One enrollment per user.
    await ctx.client.mfaEnrollment.create({ data: { authId: user.id } });
    await expect(
      ctx.client.mfaEnrollment.create({ data: { authId: user.id } }),
    ).rejects.toThrow();
  });
});
