// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { UserRole } from '../src/auth/interfaces/auth.interface';
import { totpCode } from '../src/auth/mfa/mfa-totp';
import { AuthStateCleanupService } from '../src/auth/state/auth-state-cleanup.service';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
import type { RateLimitStore } from '../src/infrastructure/rate-limit/rate-limit.store';
import { FakeGoogle, type FakeGoogleUser } from './support/fake-google';
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
} from './support/mfa-e2e';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(120_000);

const PASSWORD = 'correct horse battery staple';
const HEADER = 'X-Step-Up-Token';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

interface Approval {
  stepUpToken: string;
  action: string;
  method: string;
  expiresAt: string;
}

/**
 * Step-up authentication through the real endpoints of the whole application
 * on a temporary, freshly migrated PostgreSQL schema: every sensitive action
 * (MFA enrollment, recovery codes, subscription cancellation, data export and
 * download, account deletion) needs a ten-minute approval bound to the user,
 * the sign-in session and the action. MFA users approve with an
 * authenticator or recovery code, others with their password, Google-only
 * users by signing in with Google again (Google's servers simulated).
 * Trusted devices never replace it.
 */
describeWithDatabase('Step-up authentication (e2e, PostgreSQL)', () => {
  let ctx: TestApplication;
  let kit: MfaTestKit;
  const google = new FakeGoogle();

  beforeAll(async () => {
    ctx = await bootApplication();
    kit = new MfaTestKit(ctx, '198.22');
    google.install();
    freezeTime(kit.clock);
    kit.nextStepStart();
  });

  afterAll(async () => {
    google.uninstall();
    jest.useRealTimers();
    await ctx?.close();
  });

  beforeEach(() => kit.nextStepStart(60 * MIN));

  const http = () => kit.http();

  /** POST /auth/step-up (raw response). */
  const stepUp = (user: TestUser, body: Record<string, unknown>) =>
    http().post('/auth/step-up').set(kit.as(user)).send(body);

  const approvalOf = async (
    user: TestUser,
    action: string,
    proof: Record<string, unknown> = { password: PASSWORD },
  ) => dataOf<Approval>(await stepUp(user, { action, ...proof }).expect(201));

  const approvalsOf = (user: TestUser) =>
    ctx.client.stepUpApproval.findMany({ where: { authId: user.id } });

  /** A user with MFA enabled; returns the recovery codes too. */
  async function mfaUser() {
    const user = await kit.createUser();
    const { recoveryCodes } = await kit.enableMfa(user);
    return { user, recoveryCodes };
  }

  /**
   * The protected routes, each as a request of `user` with optional
   * headers, and the records it protects (compared before and after a
   * refused request).
   */
  const routes: Record<
    string,
    {
      send: (user: TestUser, headers: Record<string, string>) => request.Test;
      records: (user: TestUser) => Promise<unknown>;
      mfa?: boolean;
    }
  > = {
    MFA_ENROLLMENT: {
      send: (user, headers) =>
        http().post('/auth/mfa/enrollment').set(kit.as(user)).set(headers),
      records: async (user) => [
        await ctx.client.mfaEnrollment.findUnique({
          where: { authId: user.id },
        }),
        await ctx.client.authSecurity.findUnique({
          where: { authId: user.id },
        }),
      ],
    },
    MFA_RECOVERY_CODES: {
      mfa: true,
      send: (user, headers) =>
        http().post('/auth/mfa/recovery-codes').set(kit.as(user)).set(headers),
      records: (user) =>
        ctx.client.mfaRecoveryCode.findMany({
          where: { authId: user.id },
          orderBy: { id: 'asc' },
        }),
    },
    MFA_DISABLE: {
      mfa: true,
      send: (user, headers) =>
        http().post('/auth/mfa/disable').set(kit.as(user)).set(headers),
      records: async (user) => [
        await ctx.client.authSecurity.findUnique({
          where: { authId: user.id },
        }),
        await ctx.client.mfaRecoveryCode.count({ where: { authId: user.id } }),
        await ctx.client.mfaTrustedDevice.findMany({
          where: { authId: user.id },
        }),
      ],
    },
    MFA_AUTHENTICATOR_REPLACE: {
      mfa: true,
      send: (user, headers) =>
        http()
          .post('/auth/mfa/authenticator/replacement')
          .set(kit.as(user))
          .set(headers),
      records: async (user) => [
        await ctx.client.authSecurity.findUnique({
          where: { authId: user.id },
        }),
        await ctx.client.mfaEnrollment.findUnique({
          where: { authId: user.id },
        }),
      ],
    },
    SUBSCRIPTION_CANCEL: {
      send: (user, headers) =>
        http().post('/v1/subscription/cancel').set(kit.as(user)).set(headers),
      records: async (user) => [
        await ctx.client.userSubscription.findUnique({
          where: { authId: user.id },
        }),
        await ctx.client.activityLogEvent.count({
          where: { actionedBy: user.id },
        }),
      ],
    },
    DATA_EXPORT: {
      send: (user, headers) =>
        http().post('/v1/privacy/exports').set(kit.as(user)).set(headers),
      records: (user) =>
        ctx.client.dataExport.findMany({ where: { authId: user.id } }),
    },
    DATA_EXPORT_DOWNLOAD: {
      send: (user, headers) =>
        http()
          .get(`/v1/privacy/exports/${randomUUIDLike(user)}/download`)
          .set(kit.as(user))
          .set(headers),
      records: (user) =>
        ctx.client.dataExport.findMany({ where: { authId: user.id } }),
    },
    ACCOUNT_DELETION: {
      send: (user, headers) =>
        http()
          .post('/v1/privacy/account-deletion')
          .set(kit.as(user))
          .set(headers)
          .send({ password: PASSWORD, code: 'ABC123' }),
      records: async (user) => [
        await ctx.client.authUser.findUnique({ where: { id: user.id } }),
        await ctx.client.accountDeletionRequest.count({
          where: { authId: user.id },
        }),
      ],
    },
  };
  /** A stable, well-formed export ID per user (routes validate UUIDs). */
  const randomUUIDLike = (user: TestUser) =>
    `${sha256(user.id).slice(0, 8)}-0000-4000-8000-${sha256(user.id).slice(0, 12)}`;

  describe('every sensitive action', () => {
    it.each(Object.keys(routes))(
      '%s answers 403 without a valid approval, and changes nothing',
      async (action) => {
        const route = routes[action];
        const user = route.mfa
          ? (await mfaUser()).user
          : await kit.createUser();
        const before = await route.records(user);

        const missing = await route.send(user, {}).expect(403);
        expect(messageOf(missing)).toBe(
          `Step-up authentication is required for this action (${action})`,
        );
        for (const token of [
          'stup_forged',
          `stup_${randomBytes(32).toString('base64url')}`,
        ]) {
          const forged = await route
            .send(user, { [HEADER]: token })
            .expect(403);
          expect(messageOf(forged)).toContain('missing, expired or not valid');
        }

        expect(await route.records(user)).toEqual(before);
      },
    );

    it.each(Object.keys(routes))(
      '%s runs with a valid approval (the request passes the gate)',
      async (action) => {
        const route = routes[action];
        const user = route.mfa
          ? (await mfaUser()).user
          : await kit.createUser();
        const token = await kit.approve(user, action);

        const response = await route.send(user, { [HEADER]: token });

        // Whatever the action itself answers (409 without a subscription,
        // 404 without an export, 403 for a wrong deletion code), it is no
        // longer the step-up refusal.
        expect(response.status).toBeLessThan(500);
        expect(JSON.stringify(response.body)).not.toMatch(
          /Step-up authentication is required|step-up approval is missing/,
        );
      },
    );
  });

  describe('approvals', () => {
    it('are stored per user, session and action, as hashes, for ten minutes', async () => {
      const user = await kit.createUser();

      const approval = await approvalOf(user, 'DATA_EXPORT');

      expect(approval).toEqual({
        stepUpToken: expect.stringMatching(
          /^stup_[A-Za-z0-9_-]{43}$/,
        ) as string,
        action: 'DATA_EXPORT',
        method: 'PASSWORD',
        expiresAt: new Date(kit.clock.getTime() + 10 * MIN).toISOString(),
      });
      const session = await ctx.client.refreshSession.findFirstOrThrow({
        where: { authId: user.id, revokedAt: null },
      });
      expect(await approvalsOf(user)).toEqual([
        expect.objectContaining({
          authId: user.id,
          sessionId: session.familyId,
          action: 'DATA_EXPORT',
          method: 'PASSWORD',
          tokenHash: sha256(approval.stepUpToken),
          createdAt: kit.clock,
          expiresAt: new Date(kit.clock.getTime() + 10 * MIN),
        }),
      ]);
      expect(JSON.stringify(await approvalsOf(user))).not.toContain(
        approval.stepUpToken,
      );
      // The database refuses approvals longer than ten minutes.
      await expect(
        ctx.client.stepUpApproval.create({
          data: {
            authId: user.id,
            sessionId: session.familyId,
            action: 'DATA_EXPORT',
            method: 'PASSWORD',
            tokenHash: sha256('x'),
            createdAt: kit.clock,
            expiresAt: new Date(kit.clock.getTime() + 11 * MIN),
          },
        }),
      ).rejects.toThrow();
    });

    it('are valid for ten minutes, then refused (expired)', async () => {
      const user = await kit.createUser();
      const { stepUpToken } = await approvalOf(user, 'DATA_EXPORT');

      kit.advance(10 * MIN - SECOND);
      await routes.DATA_EXPORT.send(user, { [HEADER]: stepUpToken }).expect(
        202,
      );
      kit.advance(SECOND);
      const expired = await routes.DATA_EXPORT.send(user, {
        [HEADER]: stepUpToken,
      }).expect(403);
      expect(messageOf(expired)).toContain('missing, expired or not valid');
      // The hourly authentication sweep removes expired approvals.
      kit.advance(MIN);
      await ctx
        .get<AuthStateCleanupService>(AuthStateCleanupService)
        .sweep(kit.clock);
      expect(await approvalsOf(user)).toEqual([]);
    });

    it('only approve their own action', async () => {
      const user = await kit.createUser();
      const { stepUpToken } = await approvalOf(user, 'DATA_EXPORT');

      for (const action of [
        'ACCOUNT_DELETION',
        'SUBSCRIPTION_CANCEL',
        'MFA_ENROLLMENT',
        'DATA_EXPORT_DOWNLOAD',
      ]) {
        const before = await routes[action].records(user);
        await routes[action].send(user, { [HEADER]: stepUpToken }).expect(403);
        expect(await routes[action].records(user)).toEqual(before);
      }
    });

    it('never work for another user', async () => {
      const alice = await kit.createUser();
      const bob = await kit.createUser();
      const { stepUpToken } = await approvalOf(alice, 'DATA_EXPORT');

      await routes.DATA_EXPORT.send(bob, { [HEADER]: stepUpToken }).expect(403);
      expect(
        await ctx.client.dataExport.count({ where: { authId: bob.id } }),
      ).toBe(0);
    });

    it("never work for another user, even with that user's session ID", async () => {
      // A crafted record: Alice's approval carrying Bob's current session ID
      // (the session check alone would accept it; the owner check must not).
      const alice = await kit.createUser();
      const bob = await kit.createUser();
      const bobSession = await ctx.client.refreshSession.findFirstOrThrow({
        where: { authId: bob.id, revokedAt: null },
      });
      const token = `stup_${randomBytes(32).toString('base64url')}`;
      await ctx.client.stepUpApproval.create({
        data: {
          authId: alice.id,
          sessionId: bobSession.familyId,
          action: 'DATA_EXPORT',
          method: 'PASSWORD',
          tokenHash: sha256(token),
          createdAt: kit.clock,
          expiresAt: new Date(kit.clock.getTime() + 10 * MIN),
        },
      });

      await routes.DATA_EXPORT.send(bob, { [HEADER]: token }).expect(403);
      expect(
        await ctx.client.dataExport.count({ where: { authId: bob.id } }),
      ).toBe(0);
    });

    it('only work in the session that approved them, including after token refreshes', async () => {
      const user = await kit.createUser();
      const sessionA = { ...user }; // the sign-in of createUser()
      // Session B approves.
      const login = dataOf<{ refreshToken: string; accessToken: string }>(
        await kit.login(user).expect(201),
      );
      const sessionB = { ...user, accessToken: login.accessToken };
      const { stepUpToken } = await approvalOf(sessionB, 'DATA_EXPORT');

      // Other sessions of the same user (A, and a new sign-in C): refused.
      const sessionC = { ...user };
      await kit.signIn(sessionC);
      await routes.DATA_EXPORT.send(sessionC, { [HEADER]: stepUpToken }).expect(
        403,
      );
      await routes.DATA_EXPORT.send(sessionA, { [HEADER]: stepUpToken }).expect(
        403,
      );
      expect(
        await ctx.client.dataExport.count({ where: { authId: user.id } }),
      ).toBe(0);

      // Session B keeps it across a refresh-token rotation (same `sid`).
      const refreshed = dataOf<{ accessToken: string }>(
        await http()
          .post('/auth/refresh-token')
          .set('X-Forwarded-For', user.ip)
          .send({ refreshToken: login.refreshToken })
          .expect(201),
      );
      await routes.DATA_EXPORT.send(
        { ...user, accessToken: refreshed.accessToken },
        { [HEADER]: stepUpToken },
      ).expect(202);
    });

    it('end with their session (logout)', async () => {
      const user = await kit.createUser();
      const login = dataOf<{ refreshToken: string; accessToken: string }>(
        await kit.login(user).expect(201),
      );
      user.accessToken = login.accessToken;
      const { stepUpToken } = await approvalOf(user, 'DATA_EXPORT');

      await http()
        .post('/auth/logout')
        .set(kit.as(user))
        .send({ refreshToken: login.refreshToken })
        .expect(201);

      // The session's access token stops working at once, so neither its
      // approvals nor a new step-up can be used any more.
      await http().get('/auth/mfa').set(kit.as(user)).expect(401);
      await routes.DATA_EXPORT.send(user, { [HEADER]: stepUpToken }).expect(
        401,
      );
      await stepUp(user, { action: 'DATA_EXPORT', password: PASSWORD }).expect(
        401,
      );
    });

    it('cannot be made by access tokens without a session (issued before sessions)', async () => {
      const user = await kit.createUser();
      const legacy = {
        ...user,
        accessToken: new AuthUtilsService(
          {} as RateLimitStore,
        ).createAccessToken({
          userId: user.id,
          role: UserRole.USER,
          tokenVersion: 1,
        }),
      };

      const refused = await stepUp(legacy, {
        action: 'DATA_EXPORT',
        password: PASSWORD,
      }).expect(401);
      expect(messageOf(refused)).toBe(
        'This session cannot approve sensitive actions. Please sign in again.',
      );
      const { stepUpToken } = await approvalOf(user, 'DATA_EXPORT');
      await routes.DATA_EXPORT.send(legacy, { [HEADER]: stepUpToken }).expect(
        403,
      );
    });
  });

  describe('users without MFA: the current password', () => {
    it('is required, and a wrong one counts toward the account lockout', async () => {
      const user = await kit.createUser();

      const wrong = await stepUp(user, {
        action: 'DATA_EXPORT',
        password: 'wrong password',
      }).expect(403);
      expect(messageOf(wrong)).toBe('Incorrect password');
      expect(
        (
          await ctx.client.authSecurity.findUniqueOrThrow({
            where: { authId: user.id },
          })
        ).failedAttempts,
      ).toBe(1);
      await stepUp(user, { action: 'DATA_EXPORT', code: '123456' }).expect(400);
      await stepUp(user, { action: 'DATA_EXPORT' }).expect(400);
      await stepUp(user, {
        action: 'NOT_AN_ACTION',
        password: PASSWORD,
      }).expect(400);
      expect(await approvalsOf(user)).toEqual([]);

      await approvalOf(user, 'DATA_EXPORT');
      expect(
        (
          await ctx.client.authSecurity.findUniqueOrThrow({
            where: { authId: user.id },
          })
        ).failedAttempts,
      ).toBe(0);
    });
  });

  describe('MFA users: an authenticator code or an unused recovery code', () => {
    it('approve with the current authenticator code, never the password', async () => {
      const { user } = await mfaUser();
      expect(
        dataOf<{ method: string }>(
          await http().get('/auth/step-up').set(kit.as(user)).expect(200),
        ).method,
      ).toBe('mfa');

      await stepUp(user, { action: 'DATA_EXPORT', password: PASSWORD }).expect(
        400,
      );
      kit.nextStepStart();
      const code = totpCode(user.totpSecret as string, kit.clock);
      const approval = await approvalOf(user, 'DATA_EXPORT', { code });
      expect(approval.method).toBe('TOTP');
      // The same code is used up.
      await stepUp(user, { action: 'DATA_EXPORT', code }).expect(400);
    });

    it('approve with an unused recovery code, which is consumed', async () => {
      const { user, recoveryCodes } = await mfaUser();

      const approval = await approvalOf(user, 'SUBSCRIPTION_CANCEL', {
        recoveryCode: recoveryCodes[0],
      });

      expect(approval.method).toBe('RECOVERY_CODE');
      expect(
        await ctx.client.mfaRecoveryCode.count({
          where: { authId: user.id, usedAt: { not: null } },
        }),
      ).toBe(1);
      await stepUp(user, {
        action: 'SUBSCRIPTION_CANCEL',
        recoveryCode: recoveryCodes[0],
      }).expect(400);
    });

    it('share the MFA lockout (5 incorrect codes in 15 minutes)', async () => {
      const { user, recoveryCodes } = await mfaUser();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push(
          (
            await stepUp(user, {
              action: 'DATA_EXPORT',
              recoveryCode: 'ABCDE-FGHJK',
            })
          ).status,
        );
      }
      expect(statuses).toEqual([400, 400, 400, 400, 429]);
      await stepUp(user, {
        action: 'DATA_EXPORT',
        recoveryCode: recoveryCodes[0],
      }).expect(429);
      // (Its only approval is the one that enabled MFA.)
      expect(
        (await approvalsOf(user)).filter((a) => a.action === 'DATA_EXPORT'),
      ).toEqual([]);
    });

    it('are never exempted by a trusted device', async () => {
      const { user } = await mfaUser();
      const { challengeToken } = dataOf<{ challengeToken: string }>(
        await kit.login(user).expect(201),
      );
      kit.nextStepStart();
      const device = dataOf<{ trustedDevice: { token: string } }>(
        await http()
          .post('/auth/login/mfa')
          .set('X-Forwarded-For', user.ip)
          .send({
            challengeToken,
            code: totpCode(user.totpSecret as string, kit.clock),
            trustDevice: true,
          })
          .expect(200),
      ).trustedDevice;
      // The trusted device skips the MFA step of sign-in...
      user.trustedDeviceToken = device.token;
      const signedIn = dataOf<{ mfaRequired: boolean; accessToken: string }>(
        await kit.login(user).expect(201),
      );
      expect(signedIn.mfaRequired).toBe(false);
      user.accessToken = signedIn.accessToken;
      const withDevice = { 'X-MFA-Trusted-Device': device.token };

      // ...but never a step-up: refused without an approval,
      await routes.DATA_EXPORT.send(user, withDevice).expect(403);
      // the device token is not an approval,
      await routes.DATA_EXPORT.send(user, {
        ...withDevice,
        [HEADER]: device.token,
      }).expect(403);
      // and the step-up still needs a code.
      await http()
        .post('/auth/step-up')
        .set(kit.as(user))
        .set(withDevice)
        .send({ action: 'DATA_EXPORT' })
        .expect(400);
      expect(
        await ctx.client.dataExport.count({ where: { authId: user.id } }),
      ).toBe(0);
      const approval = await kit.approve(user, 'DATA_EXPORT');
      await routes.DATA_EXPORT.send(user, {
        ...withDevice,
        [HEADER]: approval,
      }).expect(202);
    });
  });

  describe('Google-only users: a new Google sign-in', () => {
    const profile = (): FakeGoogleUser => {
      const tag = randomBytes(4).toString('hex');
      return { sub: `g-${tag}`, email: `g_${tag}@example.com`, name: 'Gina G' };
    };
    let ipCounter = 0;

    /** Signs in with Google (first time: sign-up) and returns the session. */
    async function googleSession(who: FakeGoogleUser): Promise<TestUser> {
      const { state } = dataOf<{ state: string }>(
        await http().get('/auth/google').expect(200),
      );
      const result = (
        (
          await http()
            .post('/auth/google/callback')
            .send({ code: google.codeFor(who), state })
            .expect(201)
        ).body as {
          data: { data: { accessToken: string; user: { id: string } } };
        }
      ).data.data;
      ipCounter += 1;
      return {
        id: result.user.id,
        email: who.email,
        ip: `198.23.0.${ipCounter}`,
        accessToken: result.accessToken,
      };
    }

    const startGoogle = async (user: TestUser, action = 'DATA_EXPORT') =>
      dataOf<{ url: string; state: string; expiresAt: string }>(
        await http()
          .post('/auth/step-up/google')
          .set(kit.as(user))
          .send({ action })
          .expect(201),
      );
    const nonceOf = (url: string) => new URL(url).searchParams.get('nonce');
    /** auth_time of a Google sign-in happening now (seconds). */
    const signedInNow = () => Math.floor(kit.clock.getTime() / 1000);
    const callback = (user: TestUser, body: { code: string; state: string }) =>
      http().post('/auth/step-up/google/callback').set(kit.as(user)).send(body);

    it('need Google (no password to check) and get an approval from it', async () => {
      const who = profile();
      const user = await googleSession(who);
      expect(
        dataOf<{ method: string }>(
          await http().get('/auth/step-up').set(kit.as(user)).expect(200),
        ).method,
      ).toBe('google');
      await stepUp(user, { action: 'DATA_EXPORT', password: '' }).expect(400);
      await stepUp(user, {
        action: 'DATA_EXPORT',
        password: 'anything',
      }).expect(400);

      const started = await startGoogle(user);
      const url = new URL(started.url);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: google.clientId,
        state: started.state,
        login_hint: who.email,
        prompt: 'select_account',
        code_challenge_method: 'S256',
      });
      // The request asks Google for auth_time in the signed ID token.
      expect(JSON.parse(url.searchParams.get('claims') as string)).toEqual({
        id_token: { auth_time: { essential: true } },
      });
      expect(url.searchParams.get('max_age')).toBe('0');
      const approval = dataOf<Approval>(
        await callback(user, {
          code: google.codeFor(who, {
            nonce: nonceOf(started.url),
            auth_time: signedInNow(),
          }),
          state: started.state,
        }).expect(201),
      );
      expect(approval).toMatchObject({
        action: 'DATA_EXPORT',
        method: 'GOOGLE',
      });
      await routes.DATA_EXPORT.send(user, {
        [HEADER]: approval.stepUpToken,
      }).expect(202);
    });

    it.each([
      'expired',
      'repeated',
      'another session of the same user',
      'another user',
      'another Google account',
      'a token for another challenge (nonce)',
      'a sign-in older than the challenge',
      'a signed ID token without auth_time',
      'an auth_time in the future',
    ])('refuse %s (403), approving nothing', async (variant) => {
      const who = profile();
      const user = await googleSession(who);
      const started = await startGoogle(user);
      const nonce = nonceOf(started.url);
      let caller = user;
      let signedInAs = who;
      // Everything valid (including a fresh auth_time) except the variant.
      const claims: Record<string, unknown> = {
        nonce,
        auth_time: signedInNow(),
      };

      if (variant === 'expired') kit.advance(10 * MIN);
      if (variant === 'repeated') {
        await callback(user, {
          code: google.codeFor(who, { nonce, auth_time: signedInNow() }),
          state: started.state,
        }).expect(201);
        await ctx.client.stepUpApproval.deleteMany({
          where: { authId: user.id },
        });
      }
      if (variant === 'another session of the same user') {
        caller = await googleSession(who);
      }
      if (variant === 'another user') caller = await googleSession(profile());
      if (variant === 'another Google account') signedInAs = profile();
      if (variant === 'a token for another challenge (nonce)') {
        claims.nonce = randomBytes(32).toString('base64url');
      }
      if (variant === 'a sign-in older than the challenge') {
        claims.auth_time = Math.floor(kit.clock.getTime() / 1000) - 3600;
      }
      if (variant === 'a signed ID token without auth_time') {
        delete claims.auth_time;
      }
      if (variant === 'an auth_time in the future') {
        claims.auth_time = Math.floor(kit.clock.getTime() / 1000) + 3600;
      }

      const refused = await callback(caller, {
        code: google.codeFor(signedInAs, claims),
        state: started.state,
      }).expect(403);

      expect(messageOf(refused)).toMatch(/Start again|does not match/);
      expect(await approvalsOf(user)).toEqual([]);
      expect(await approvalsOf(caller)).toEqual([]);
    });
  });

  describe('the protected actions, approved', () => {
    it('export: request, link and archive download each need their approval', async () => {
      const user = await kit.createUser();
      const exportApproval = await kit.approve(user, 'DATA_EXPORT');
      const requested = dataOf<{ id: string }>(
        await routes.DATA_EXPORT.send(user, {
          [HEADER]: exportApproval,
        }).expect(202),
      );
      await eventually(
        async () =>
          (
            await ctx.client.dataExport.findUniqueOrThrow({
              where: { id: requested.id },
            })
          ).status === 'COMPLETED',
        60_000,
        'the export',
      );
      const link = `/v1/privacy/exports/${requested.id}/download`;

      await http().get(link).set(kit.as(user)).expect(403);
      await http()
        .get(link)
        .set(kit.as(user))
        .set(HEADER, exportApproval) // approves DATA_EXPORT, not the download
        .expect(403);
      const download = await kit.approve(user, 'DATA_EXPORT_DOWNLOAD');
      const { url } = dataOf<{ url: string }>(
        await http()
          .get(link)
          .set(kit.as(user))
          .set(HEADER, download)
          .expect(200),
      );
      await http().get(url).set(kit.as(user)).expect(403);
      const archive = await http()
        .get(url)
        .set(kit.as(user))
        .set(HEADER, download)
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect((archive.body as Buffer).subarray(0, 2).toString('latin1')).toBe(
        'PK',
      );
    });

    it('recovery codes: regenerated only with an approval', async () => {
      const { user, recoveryCodes } = await mfaUser();
      const approval = await kit.approve(user, 'MFA_RECOVERY_CODES', {
        recoveryCode: recoveryCodes[0],
      });

      const fresh = dataOf<{ recoveryCodes: string[] }>(
        await routes.MFA_RECOVERY_CODES.send(user, {
          [HEADER]: approval,
        }).expect(201),
      );
      expect(fresh.recoveryCodes).toHaveLength(10);
    });

    it('account deletion: accepted only with an approval', async () => {
      const user = await kit.createUser();
      await http()
        .post('/v1/privacy/account-deletion/confirmation-code')
        .set(kit.as(user))
        .expect(202);
      const sent = await eventually(
        () =>
          Promise.resolve(
            ctx.emails.sent.find(
              (item) =>
                item.kind === 'account-deletion-code' && item.to === user.email,
            ),
          ),
        60_000,
        'the deletion code',
      );
      const body = { password: PASSWORD, code: sent.code };

      await http()
        .post('/v1/privacy/account-deletion')
        .set(kit.as(user))
        .send(body)
        .expect(403);
      expect(
        (
          await ctx.client.authUser.findUniqueOrThrow({
            where: { id: user.id },
          })
        ).status,
      ).toBe('ACTIVE');

      const approval = await kit.approve(user, 'ACCOUNT_DELETION');
      await http()
        .post('/v1/privacy/account-deletion')
        .set(kit.as(user))
        .set(HEADER, approval)
        .send(body)
        .expect(202);
      expect(
        (
          await ctx.client.authUser.findUniqueOrThrow({
            where: { id: user.id },
          })
        ).status,
      ).toBe('PENDING_DELETION');
    });
  });
});
