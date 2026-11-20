// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import { createHash, randomBytes } from 'node:crypto';
import type { IMfaLoginResponse } from '../src/auth/interfaces/auth.interface';
import type {
  MfaChallengeView,
  TrustedDeviceListItem,
} from '../src/auth/mfa/mfa-login.service';
import { totpCode, totpStep } from '../src/auth/mfa/mfa-totp';
import { MFA_LOGIN } from '../src/auth/mfa/mfa.constants';
import {
  decryptSecret,
  keyedHash,
  SECRET_PURPOSES,
} from '../src/common/security/derived-secrets';
import { FakeGoogle, type FakeGoogleUser } from './support/fake-google';
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
  SECOND,
  type TestUser,
  wrongCode,
} from './support/mfa-e2e';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(120_000);

const DAY = 24 * 60 * MIN;
const HEADER = MFA_LOGIN.TRUSTED_DEVICE_HEADER;
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

interface Tokens {
  mfaRequired: false;
  accessToken: string;
  refreshToken: string;
  user: { id: string };
}

/**
 * MFA at sign-in through the real endpoints of the whole application on a
 * temporary, freshly migrated PostgreSQL schema: password and Google sign-in
 * of users with and without MFA, the MFA challenge and the tokens issued
 * after it, trusted devices (validity, 30-day expiry, revocation), and
 * ownership. Only Google's servers are simulated (support/fake-google.ts).
 */
describeWithDatabase('MFA at sign-in (e2e, PostgreSQL)', () => {
  let ctx: TestApplication;
  let kit: MfaTestKit;
  const google = new FakeGoogle();

  beforeAll(async () => {
    ctx = await bootApplication();
    kit = new MfaTestKit(ctx, '198.20');
    google.install();
    freezeTime(kit.clock);
    kit.nextStepStart();
  });

  afterAll(async () => {
    google.uninstall();
    jest.useRealTimers();
    await ctx?.close();
  });

  // Far apart, so sign-in rate limits and tokens of other tests never matter.
  beforeEach(() => kit.nextStepStart(60 * MIN));

  const http = () => kit.http();

  /** A user with MFA enabled (through the API); returns the recovery codes. */
  async function mfaUser() {
    const user = await kit.createUser();
    const { recoveryCodes } = await kit.enableMfa(user);
    return { user, recoveryCodes };
  }

  /** Password sign-in that must end in an MFA challenge. */
  async function challengeOf(user: TestUser): Promise<MfaChallengeView> {
    const body = dataOf<MfaChallengeView>(await kit.login(user).expect(201));
    expect(body.mfaRequired).toBe(true);
    return body;
  }

  const completeMfa = (
    user: TestUser,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ) =>
    http()
      .post('/auth/login/mfa')
      .set('X-Forwarded-For', user.ip)
      .set(extraHeaders)
      .send(body);

  /** A fresh authenticator code (the next 30-second step, never used). */
  const freshCode = (user: TestUser) => {
    kit.nextStepStart();
    return totpCode(user.totpSecret as string, kit.clock);
  };

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sessionsOf = (user: TestUser) =>
    ctx.client.refreshSession.count({ where: { authId: user.id } });
  const challengesOf = (user: TestUser) =>
    ctx.client.mfaLoginChallenge.findMany({ where: { authId: user.id } });
  const devicesOf = (user: TestUser) =>
    ctx.client.mfaTrustedDevice.findMany({ where: { authId: user.id } });

  /** Proves a token pair is a real, working sign-in of `user`. */
  async function expectWorkingSession(user: TestUser, tokens: Tokens) {
    expect(tokens.user.id).toBe(user.id);
    const status = await http()
      .get('/auth/mfa')
      .set(bearer(tokens.accessToken))
      .expect(200);
    expect(dataOf<{ enabled: boolean }>(status)).toBeDefined();
    await http()
      .post('/auth/refresh-token')
      .set('X-Forwarded-For', user.ip)
      .send({ refreshToken: tokens.refreshToken })
      .expect(201);
  }

  describe('users without MFA', () => {
    it('sign in with their password exactly as before', async () => {
      const user = await kit.createUser();

      const response = await kit.login(user).expect(201);

      const body = dataOf<Tokens>(response);
      expect(body).toMatchObject({
        mfaRequired: false,
        accessToken: expect.any(String) as string,
        refreshToken: expect.any(String) as string,
        expiresIn: 900,
      });
      expect(body).not.toHaveProperty('challengeToken');
      await expectWorkingSession(user, body);
      expect(await challengesOf(user)).toEqual([]);
    });

    it('ignore a trusted-device header (nothing to skip)', async () => {
      const user = await kit.createUser();
      user.trustedDeviceToken = `mfatd_${randomBytes(32).toString('base64url')}`;

      const body = dataOf<Tokens>(await kit.login(user).expect(201));

      expect(body.mfaRequired).toBe(false);
      await expectWorkingSession(user, body);
    });
  });

  describe('the MFA challenge', () => {
    it('replaces the tokens of a correct password sign-in', async () => {
      const { user } = await mfaUser();
      const sessionsBefore = await sessionsOf(user);

      const response = await kit.login(user).expect(201);

      const body = dataOf<MfaChallengeView>(response);
      expect(body).toEqual({
        mfaRequired: true,
        challengeToken: expect.stringMatching(
          /^mfac_[A-Za-z0-9_-]{43}$/,
        ) as string,
        expiresAt: new Date(kit.clock.getTime() + 5 * MIN).toISOString(),
        methods: ['totp', 'recovery_code'],
      });
      expect(body).not.toHaveProperty('accessToken');
      expect(body).not.toHaveProperty('refreshToken');
      expect(JSON.stringify(response.body)).not.toMatch(/eyJ/); // no JWT at all
      // Nothing was signed in: no refresh session was stored.
      expect(await sessionsOf(user)).toBe(sessionsBefore);
      // Stored in PostgreSQL only as a SHA-256 hash.
      const [challenge] = await challengesOf(user);
      expect(challenge).toMatchObject({
        tokenHash: sha256(body.challengeToken),
        provider: 'local',
        consumedAt: null,
        expiresAt: new Date(body.expiresAt),
      });
      expect(
        await ctx.client.loginHistory.findFirst({
          where: { authId: user.id, failureReason: 'mfa_required' },
        }),
      ).not.toBeNull();
    });

    it('is only issued after a correct password', async () => {
      const { user } = await mfaUser();

      await http()
        .post('/auth/login')
        .set('X-Forwarded-For', user.ip)
        .send({ email: user.email, password: 'wrong password' })
        .expect(401);

      expect(await challengesOf(user)).toEqual([]);
    });

    it('grants no access: not as an access token, refresh token or session', async () => {
      const { user } = await mfaUser();
      const { challengeToken } = await challengeOf(user);

      for (const path of [
        '/auth/mfa',
        '/auth/mfa/trusted-devices',
        '/v1/profile',
      ]) {
        await http().get(path).set(bearer(challengeToken)).expect(401);
      }
      // Not a JWT: refused before any lookup.
      const asRefresh = await http()
        .post('/auth/refresh-token')
        .send({ refreshToken: challengeToken })
        .expect(400);
      expect(messageOf(asRefresh)).toBe('refreshToken must be a jwt string');
      await http()
        .post('/auth/logout-all')
        .set(bearer(challengeToken))
        .expect(401);
      // ...and it is still the only way forward: completing it works.
      await completeMfa(user, {
        challengeToken,
        code: freshCode(user),
      }).expect(200);
    });
  });

  describe('token issuance after MFA', () => {
    it('issues working tokens after the authenticator code', async () => {
      const { user } = await mfaUser();
      const { challengeToken } = await challengeOf(user);
      const sessionsBefore = await sessionsOf(user);
      const code = freshCode(user);

      const response = await completeMfa(user, { challengeToken, code }).expect(
        200,
      );

      expect(response.headers['cache-control']).toBe('no-store');
      const body = dataOf<IMfaLoginResponse>(response);
      expect(body).toMatchObject({
        mfaRequired: false,
        mfaMethod: 'totp',
        trustedDevice: null,
        expiresIn: 900,
        user: { id: user.id, email: user.email },
      });
      await expectWorkingSession(user, body as unknown as Tokens);
      expect(await sessionsOf(user)).toBe(sessionsBefore + 2); // + rotation
      const [challenge] = await challengesOf(user);
      expect(challenge.consumedAt).toEqual(kit.clock);
      expect(
        (
          await ctx.client.authSecurity.findUniqueOrThrow({
            where: { authId: user.id },
          })
        ).mfaLastUsedStep,
      ).toBe(totpStep(kit.clock));
    });

    it('issues working tokens after an unused recovery code, consuming it', async () => {
      const { user, recoveryCodes } = await mfaUser();
      const { challengeToken } = await challengeOf(user);

      const response = await completeMfa(user, {
        challengeToken,
        recoveryCode: recoveryCodes[2],
      }).expect(200);

      const body = dataOf<IMfaLoginResponse>(response);
      expect(body.mfaMethod).toBe('recovery_code');
      await expectWorkingSession(user, body as unknown as Tokens);
      expect(
        await ctx.client.mfaRecoveryCode.count({
          where: { authId: user.id, usedAt: { not: null } },
        }),
      ).toBe(1);
    });

    it('declines invalid, used, expired and other users’ codes', async () => {
      const { user: alice, recoveryCodes: aliceCodes } = await mfaUser();
      const { user: bob, recoveryCodes: bobCodes } = await mfaUser();
      // One of Alice's recovery codes is used already.
      await completeMfa(alice, {
        challengeToken: (await challengeOf(alice)).challengeToken,
        recoveryCode: aliceCodes[0],
      }).expect(200);
      const { challengeToken } = await challengeOf(alice);
      const current = freshCode(alice);

      const declined = [
        { code: wrongCode(current) },
        { recoveryCode: aliceCodes[0] }, // already used
        { recoveryCode: bobCodes[0] }, // Bob's
      ];
      for (const factor of declined) {
        const response = await completeMfa(alice, {
          challengeToken,
          ...factor,
        });
        expect([response.status, messageOf(response)]).toEqual([
          400,
          expect.stringMatching(/^Invalid MFA code\./),
        ]);
      }
      // An expired code: the step of `current` is over.
      kit.advance(30 * SECOND);
      const expired = await completeMfa(alice, {
        challengeToken,
        code: current,
      }).expect(400);
      expect(messageOf(expired)).toBe(
        'Invalid MFA code. 1 attempt(s) remaining.',
      );
      expect(
        await ctx.client.mfaRecoveryCode.count({
          where: { authId: bob.id, usedAt: { not: null } },
        }),
      ).toBe(0);
      expect(await sessionsOf(bob)).toBe(1);
      // The challenge was never consumed.
      expect(
        (await challengesOf(alice)).find(
          (c) => c.tokenHash === sha256(challengeToken),
        )?.consumedAt,
      ).toBeNull();
    });

    it("never completes with another user's authenticator code", async () => {
      const { user: alice } = await mfaUser();
      const { user: bob } = await mfaUser();
      const { challengeToken } = await challengeOf(alice);

      await completeMfa(alice, {
        challengeToken,
        code: freshCode(bob),
      }).expect(400);
      await completeMfa(alice, {
        challengeToken,
        code: totpCode(alice.totpSecret as string, kit.clock),
      }).expect(200);
    });

    describe('when the sign-in session cannot be created', () => {
      /**
       * Makes PostgreSQL itself refuse the refresh session of `user` (a
       * trigger on "RefreshSession"), so the real transaction fails exactly
       * where the session is written.
       */
      async function failSessionsOf(user: TestUser) {
        await ctx.client.$executeRawUnsafe(`
          CREATE OR REPLACE FUNCTION "e2e_fail_session"() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW."authId" = '${user.id}' THEN
              RAISE EXCEPTION 'e2e: refresh session refused';
            END IF;
            RETURN NEW;
          END;
          $$`);
        await ctx.client.$executeRawUnsafe(`
          CREATE TRIGGER "e2e_fail_session" BEFORE INSERT ON "RefreshSession"
          FOR EACH ROW EXECUTE FUNCTION "e2e_fail_session"()`);
      }
      async function restoreSessions() {
        await ctx.client.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS "e2e_fail_session" ON "RefreshSession"',
        );
      }
      afterEach(restoreSessions);

      const usedCodes = (user: TestUser) =>
        ctx.client.mfaRecoveryCode.count({
          where: { authId: user.id, usedAt: { not: null } },
        });

      it('keeps the recovery code and the challenge usable, and trusts nothing', async () => {
        const { user, recoveryCodes } = await mfaUser();
        const { challengeToken } = await challengeOf(user);
        const sessionsBefore = await sessionsOf(user);
        const body = {
          challengeToken,
          recoveryCode: recoveryCodes[0],
          trustDevice: true,
        };
        await failSessionsOf(user);

        const failed = await completeMfa(user, body).expect(503);

        expect(messageOf(failed)).toBe(
          'Authentication service temporarily unavailable. Please try again.',
        );
        expect(failed.body).not.toHaveProperty('data');
        // Nothing was consumed or created: one transaction, rolled back.
        expect(await usedCodes(user)).toBe(0);
        expect((await challengesOf(user))[0].consumedAt).toBeNull();
        expect(await devicesOf(user)).toEqual([]);
        expect(await sessionsOf(user)).toBe(sessionsBefore);
        expect(
          await ctx.client.activityLogEventDetail.count({
            where: {
              fieldName: 'mfaRecoveryCodesRemaining',
              event: { recordId: user.id },
            },
          }),
        ).toBe(0);
        expect(
          await ctx.client.loginHistory.count({
            where: { authId: user.id, success: true },
          }),
        ).toBe(1); // only the sign-in of createUser()

        // Once sessions can be stored again, the very same challenge and
        // recovery code complete the sign-in.
        await restoreSessions();
        const done = dataOf<IMfaLoginResponse>(
          await completeMfa(user, body).expect(200),
        );
        await expectWorkingSession(user, done as unknown as Tokens);
        expect(done.trustedDevice).not.toBeNull();
        expect(await usedCodes(user)).toBe(1);
        expect((await challengesOf(user))[0].consumedAt).not.toBeNull();
        expect(await devicesOf(user)).toHaveLength(1);
      });

      it('keeps the authenticator code usable', async () => {
        const { user } = await mfaUser();
        const { challengeToken } = await challengeOf(user);
        const code = freshCode(user);
        const { mfaLastUsedStep } =
          await ctx.client.authSecurity.findUniqueOrThrow({
            where: { authId: user.id },
          });
        await failSessionsOf(user);

        await completeMfa(user, { challengeToken, code }).expect(503);

        expect(
          (
            await ctx.client.authSecurity.findUniqueOrThrow({
              where: { authId: user.id },
            })
          ).mfaLastUsedStep,
        ).toBe(mfaLastUsedStep);
        await restoreSessions();
        await completeMfa(user, { challengeToken, code }).expect(200);
      });
    });

    it('uses each challenge once, even concurrently', async () => {
      const { user, recoveryCodes } = await mfaUser();
      const { challengeToken } = await challengeOf(user);

      const responses = await Promise.all(
        recoveryCodes
          .slice(0, 4)
          .map((recoveryCode) =>
            completeMfa(user, { challengeToken, recoveryCode }),
          ),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([
        200, 401, 401, 401,
      ]);
      // The losers' codes were not consumed.
      expect(
        await ctx.client.mfaRecoveryCode.count({
          where: { authId: user.id, usedAt: { not: null } },
        }),
      ).toBe(1);
      const again = await completeMfa(user, {
        challengeToken,
        recoveryCode: recoveryCodes[5],
      }).expect(401);
      expect(messageOf(again)).toBe(
        'The MFA challenge is invalid or has expired. Please sign in again.',
      );
    });

    it('expires the challenge after five minutes', async () => {
      const { user, recoveryCodes } = await mfaUser();
      const { challengeToken } = await challengeOf(user);

      kit.advance(5 * MIN);
      await completeMfa(user, {
        challengeToken,
        recoveryCode: recoveryCodes[0],
      }).expect(401);

      expect(
        await ctx.client.mfaRecoveryCode.count({
          where: { authId: user.id, usedAt: { not: null } },
        }),
      ).toBe(0);
    });

    it.each([
      [{ code: '123456' }, 'challengeToken is not a valid MFA challenge token'],
      [
        { challengeToken: `mfatd_${'A'.repeat(43)}`, code: '123456' },
        'challengeToken is not a valid MFA challenge token',
      ],
      [
        { challengeToken: `mfac_${'A'.repeat(43)}` },
        'Provide exactly one of code or recoveryCode',
      ],
      [
        {
          challengeToken: `mfac_${'A'.repeat(43)}`,
          code: '123456',
          userId: 'x',
        },
        'property userId should not exist',
      ],
    ])('validates the request %j', async (body, message) => {
      const user = await kit.createUser();
      const response = await completeMfa(user, body).expect(400);
      expect(messageOf(response)).toContain(message);
    });
  });

  describe('trusted devices', () => {
    /** Completes an MFA sign-in trusting the device; returns its token. */
    async function trustDevice(user: TestUser, deviceName?: string) {
      const { challengeToken } = await challengeOf(user);
      const response = await completeMfa(user, {
        challengeToken,
        code: freshCode(user),
        trustDevice: true,
        ...(deviceName ? { deviceName } : {}),
      }).expect(200);
      const body = dataOf<IMfaLoginResponse>(response);
      return body.trustedDevice as NonNullable<
        IMfaLoginResponse['trustedDevice']
      >;
    }

    it('are stored per user, as hashes, for 30 days', async () => {
      const { user } = await mfaUser();

      const device = await trustDevice(user, 'Ann’s iPhone');

      expect(device).toEqual({
        id: expect.any(String) as string,
        token: expect.stringMatching(/^mfatd_[A-Za-z0-9_-]{43}$/) as string,
        name: 'Ann’s iPhone',
        expiresAt: new Date(kit.clock.getTime() + 30 * DAY).toISOString(),
      });
      expect(await devicesOf(user)).toEqual([
        expect.objectContaining({
          id: device.id,
          authId: user.id,
          tokenHash: sha256(device.token),
          name: 'Ann’s iPhone',
          createdAt: kit.clock,
          expiresAt: new Date(kit.clock.getTime() + 30 * DAY),
          revokedAt: null,
        }),
      ]);
      const row = JSON.stringify(await devicesOf(user));
      expect(row).not.toContain(device.token);
    });

    it('skip the challenge on later sign-ins of their user', async () => {
      const { user } = await mfaUser();
      const device = await trustDevice(user);
      user.trustedDeviceToken = device.token;
      kit.advance(MIN);
      const challengesBefore = (await challengesOf(user)).length;

      const body = dataOf<Tokens>(await kit.login(user).expect(201));

      expect(body.mfaRequired).toBe(false);
      await expectWorkingSession(user, body);
      expect(await challengesOf(user)).toHaveLength(challengesBefore);
      expect((await devicesOf(user))[0].lastUsedAt).toEqual(kit.clock);
    });

    it('expire after 30 days', async () => {
      const { user } = await mfaUser();
      const device = await trustDevice(user);
      const trustedAt = kit.clock.getTime();
      user.trustedDeviceToken = device.token;

      kit.setClock(new Date(trustedAt + 30 * DAY - MIN));
      expect(
        dataOf<Tokens>(await kit.login(user).expect(201)).mfaRequired,
      ).toBe(false);

      kit.setClock(new Date(trustedAt + 30 * DAY));
      const body = dataOf<MfaChallengeView>(await kit.login(user).expect(201));
      expect(body.mfaRequired).toBe(true);
      expect(body).not.toHaveProperty('accessToken');
      // Trust cannot be extended, even in the database.
      await expect(
        ctx.client.mfaTrustedDevice.update({
          where: { id: device.id },
          data: { expiresAt: new Date(trustedAt + 60 * DAY) },
        }),
      ).rejects.toThrow(/trust period cannot change/);
    });

    it('can be listed and revoked by their owner', async () => {
      const { user } = await mfaUser();
      const laptop = await trustDevice(user, 'laptop');
      kit.advance(MIN);
      const phone = await trustDevice(user, 'phone');
      await kit.signIn(user); // fresh access token

      const listed = await http()
        .get('/auth/mfa/trusted-devices')
        .set(kit.as(user))
        .set(HEADER, phone.token)
        .expect(200);
      const list = dataOf<TrustedDeviceListItem[]>(listed);
      expect(list.map((d) => [d.name, d.current])).toEqual([
        ['phone', true],
        ['laptop', false],
      ]);
      expect(JSON.stringify(listed.body)).not.toContain(phone.token);
      expect(JSON.stringify(listed.body)).not.toContain('tokenHash');

      const revoked = await http()
        .delete(`/auth/mfa/trusted-devices/${laptop.id}`)
        .set(kit.as(user))
        .expect(200);
      expect(dataOf(revoked)).toEqual({ id: laptop.id, revoked: true });
      // Recorded in PostgreSQL, permanently.
      const row = (await devicesOf(user)).find((d) => d.id === laptop.id)!;
      expect(row.revokedAt).toEqual(kit.clock);
      await expect(
        ctx.client.mfaTrustedDevice.update({
          where: { id: laptop.id },
          data: { revokedAt: null },
        }),
      ).rejects.toThrow(/A revoked MfaTrustedDevice cannot change/);

      // The revoked device no longer skips MFA; the other one still does.
      // (A new sign-in window: at most five sign-ins per 15 minutes.)
      kit.advance(15 * MIN);
      user.trustedDeviceToken = laptop.token;
      expect(
        dataOf<MfaChallengeView>(await kit.login(user).expect(201)).mfaRequired,
      ).toBe(true);
      user.trustedDeviceToken = phone.token;
      const viaPhone = dataOf<Tokens>(await kit.login(user).expect(201));
      expect(viaPhone.mfaRequired).toBe(false);
      user.accessToken = viaPhone.accessToken;
      const after = dataOf<TrustedDeviceListItem[]>(
        await http()
          .get('/auth/mfa/trusted-devices')
          .set(kit.as(user))
          .expect(200),
      );
      expect(after.map((d) => d.id)).toEqual([phone.id]);
    });

    it("never let another user's sign-in skip MFA", async () => {
      const { user: alice } = await mfaUser();
      const { user: bob } = await mfaUser();
      const aliceDevice = await trustDevice(alice);

      bob.trustedDeviceToken = aliceDevice.token;
      const body = dataOf<MfaChallengeView>(await kit.login(bob).expect(201));

      expect(body.mfaRequired).toBe(true);
      expect(body).not.toHaveProperty('accessToken');
      expect((await devicesOf(alice))[0].lastUsedAt).toBeNull();
    });

    it('belong to their owner: others can neither see nor revoke them', async () => {
      const { user: alice } = await mfaUser();
      const { user: bob } = await mfaUser();
      const aliceDevice = await trustDevice(alice);
      await kit.signIn(bob);

      const bobList = dataOf<TrustedDeviceListItem[]>(
        await http()
          .get('/auth/mfa/trusted-devices')
          .set(kit.as(bob))
          .set(HEADER, aliceDevice.token)
          .expect(200),
      );
      expect(bobList).toEqual([]);
      const refused = await http()
        .delete(`/auth/mfa/trusted-devices/${aliceDevice.id}`)
        .set(kit.as(bob))
        .expect(404);
      expect(messageOf(refused)).toBe('Trusted device not found');
      await http()
        .delete('/auth/mfa/trusted-devices/not-a-uuid')
        .set(kit.as(bob))
        .expect(400);
      await http()
        .delete(`/auth/mfa/trusted-devices/${aliceDevice.id}`)
        .expect(401);

      expect((await devicesOf(alice))[0].revokedAt).toBeNull();
      alice.trustedDeviceToken = aliceDevice.token;
      expect(
        dataOf<Tokens>(await kit.login(alice).expect(201)).mfaRequired,
      ).toBe(false);
    });

    it('grant nothing by themselves: not as a bearer or challenge token', async () => {
      const { user } = await mfaUser();
      const device = await trustDevice(user);

      await http().get('/auth/mfa').set(bearer(device.token)).expect(401);
      // Not a JWT: refused before any lookup.
      const asRefresh = await http()
        .post('/auth/refresh-token')
        .send({ refreshToken: device.token })
        .expect(400);
      expect(messageOf(asRefresh)).toBe('refreshToken must be a jwt string');
      await completeMfa(user, {
        challengeToken: device.token,
        code: freshCode(user),
      }).expect(400);
      // And they only ever skip MFA, never the password.
      await http()
        .post('/auth/login')
        .set('X-Forwarded-For', user.ip)
        .set(HEADER, device.token)
        .send({ email: user.email, password: 'wrong password' })
        .expect(401);
    });

    it('can only be trusted for at most 30 days (database rule)', async () => {
      const user = await kit.createUser();
      await expect(
        ctx.client.mfaTrustedDevice.create({
          data: {
            authId: user.id,
            tokenHash: sha256('x'),
            name: 'too long',
            createdAt: kit.clock,
            expiresAt: new Date(kit.clock.getTime() + 31 * DAY),
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('Google sign-in', () => {
    const profile = (): FakeGoogleUser => {
      const tag = randomBytes(4).toString('hex');
      return { sub: `g-${tag}`, email: `g_${tag}@example.com`, name: 'Gina G' };
    };

    /** Starts the flow (optionally from a trusted device) and returns its state. */
    async function startGoogle(trustedDeviceToken?: string, redirect = false) {
      const req = http().get('/auth/google');
      if (redirect) req.query({ redirectUrl: 'https://app.example.com/done' });
      if (trustedDeviceToken) req.set(HEADER, trustedDeviceToken);
      const body = dataOf<{ state: string }>(await req.expect(200));
      return body.state;
    }

    async function googleCallback(
      who: FakeGoogleUser,
      trustedDeviceToken?: string,
    ) {
      const state = await startGoogle();
      const req = http()
        .post('/auth/google/callback')
        .send({ code: google.codeFor(who), state });
      if (trustedDeviceToken) req.set(HEADER, trustedDeviceToken);
      return (await req.expect(201)).body as {
        data: { data: Record<string, unknown> };
      };
    }

    /** Signs a Google user up (no MFA) and enables MFA for them. */
    async function googleMfaUser() {
      const who = profile();
      const first = (await googleCallback(who)).data.data as unknown as Tokens;
      expect(first.mfaRequired).toBe(false);
      const user: TestUser = {
        id: first.user.id,
        email: who.email,
        ip: `198.21.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
        accessToken: first.accessToken,
      };
      // A Google-only account steps up by signing in with Google again.
      const started = dataOf<{ url: string; state: string }>(
        await http()
          .post('/auth/step-up/google')
          .set(kit.as(user))
          .send({ action: 'MFA_ENROLLMENT' })
          .expect(201),
      );
      const nonce = new URL(started.url).searchParams.get('nonce');
      const approval = dataOf<{ stepUpToken: string }>(
        await http()
          .post('/auth/step-up/google/callback')
          .set(kit.as(user))
          .send({ code: google.codeFor(who, { nonce }), state: started.state })
          .expect(201),
      );
      await kit.enableMfa(user, approval.stepUpToken);
      return { who, user };
    }

    it('signs users without MFA in as before', async () => {
      const who = profile();
      const result = (await googleCallback(who)).data.data;
      expect(result).toMatchObject({
        mfaRequired: false,
        accessToken: expect.any(String) as string,
        isNewUser: true,
      });
    });

    it('answers an MFA user with a challenge, completed like a password sign-in', async () => {
      const { who, user } = await googleMfaUser();

      const result = (await googleCallback(who)).data
        .data as unknown as MfaChallengeView;

      expect(result).toMatchObject({
        mfaRequired: true,
        challengeToken: expect.stringMatching(/^mfac_/) as string,
      });
      expect(result).not.toHaveProperty('accessToken');
      expect(result).not.toHaveProperty('refreshToken');
      const [challenge] = await challengesOf(user);
      expect(challenge.provider).toBe('google');

      const done = dataOf<IMfaLoginResponse>(
        await completeMfa(user, {
          challengeToken: result.challengeToken,
          code: freshCode(user),
        }).expect(200),
      );
      await expectWorkingSession(user, done as unknown as Tokens);
    });

    it('redirects with the challenge (never tokens) in the browser flow', async () => {
      const { who } = await googleMfaUser();
      const state = await startGoogle(undefined, true);

      const response = await http()
        .get('/auth/google/callback')
        .query({ code: google.codeFor(who), state })
        .expect(302);

      const location = new URL(response.headers.location);
      expect(location.origin + location.pathname).toBe(
        'https://app.example.com/done',
      );
      expect(location.searchParams.get('mfa_required')).toBe('true');
      expect(location.searchParams.get('mfa_challenge_token')).toMatch(
        /^mfac_/,
      );
      expect(location.searchParams.get('access_token')).toBeNull();
      expect(location.searchParams.get('refresh_token')).toBeNull();
    });

    it('lets a trusted device skip MFA, in both flows, only for its owner', async () => {
      const { who, user } = await googleMfaUser();
      const result = (await googleCallback(who)).data
        .data as unknown as MfaChallengeView;
      const trusted = dataOf<IMfaLoginResponse>(
        await completeMfa(user, {
          challengeToken: result.challengeToken,
          code: freshCode(user),
          trustDevice: true,
        }).expect(200),
      ).trustedDevice!;

      // POST callback with the header.
      const skipped = (await googleCallback(who, trusted.token)).data.data;
      expect(skipped).toMatchObject({
        mfaRequired: false,
        accessToken: expect.any(String) as string,
      });
      // Browser flow: the header is sent when the flow starts; only its
      // hash travels in the OAuth state.
      const state = await startGoogle(trusted.token, true);
      const stateHash = keyedHash(SECRET_PURPOSES.OAUTH_STATE, state);
      const stored = await ctx.client.oAuthState.findUniqueOrThrow({
        where: { stateHash },
      });
      const payload = JSON.parse(
        decryptSecret(
          SECRET_PURPOSES.OAUTH_STATE,
          stored.payload,
          `google:${stateHash}`,
        ),
      ) as Record<string, unknown>;
      expect(payload.trustedDeviceTokenHash).toBe(sha256(trusted.token));
      expect(JSON.stringify(payload)).not.toContain(trusted.token);
      const redirect = await http()
        .get('/auth/google/callback')
        .query({ code: google.codeFor(who), state })
        .expect(302);
      expect(
        new URL(redirect.headers.location).searchParams.get('access_token'),
      ).toBeTruthy();

      // Another MFA user presenting this device still gets a challenge.
      const other = await googleMfaUser();
      const otherResult = (await googleCallback(other.who, trusted.token)).data
        .data;
      expect(otherResult).toMatchObject({ mfaRequired: true });
    });
  });
});
