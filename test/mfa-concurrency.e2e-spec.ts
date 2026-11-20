// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { MfaLoginService } from '../src/auth/mfa/mfa-login.service';
import { totpCode } from '../src/auth/mfa/mfa-totp';
import { CapturingSmsSender } from './support/fake-sms';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  type TestApplication,
} from './support/infrastructure-flows';
import {
  dataOf,
  MfaTestKit,
  MIN,
  SECOND,
  type TestUser,
  wrongCode,
} from './support/mfa-e2e';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(180_000);

const HEADER = 'X-Step-Up-Token';

interface MfaUser extends TestUser {
  recoveryCodes: string[];
}

interface Tokens {
  mfaRequired: boolean;
  accessToken?: string;
  refreshToken?: string;
  challengeToken?: string;
  mfaMethod?: string;
  trustedDevice?: { id: string; token: string } | null;
}

/** The `sid` claim of an access token. */
const sidOf = (accessToken: string): string =>
  (
    JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
    ) as { sid: string }
  ).sid;

const isSuccess = (r: request.Response) => r.status >= 200 && r.status < 300;

/**
 * Concurrency and persistence of MFA through the real endpoints of the whole
 * application on a temporary, freshly migrated PostgreSQL schema (mocked SMS
 * provider, captured emails). Requests race for real against PostgreSQL:
 *
 * - a recovery code, an authenticator code, an SMS code and an MFA challenge
 *   are each accepted by exactly one of concurrent requests, whatever the
 *   entry point (sign-in, verification, step-up);
 * - regeneration, replacement, disabling and enabling racing with sign-ins
 *   and verifications never leave a stale credential or session working;
 * - the SMS delivery and verification limits hold under concurrent requests;
 * - another user's requests never affect an account, even concurrently;
 * - in PostgreSQL, used or invalidated codes, revoked devices and sessions,
 *   consumed or expired challenges and approvals can never become active
 *   again, whatever a query tries.
 */
describeWithDatabase(
  'MFA concurrency and persistence (e2e, PostgreSQL)',
  () => {
    const sms = new CapturingSmsSender();
    let ctx: TestApplication;
    let kit: MfaTestKit;
    let numbers = 0;

    beforeAll(async () => {
      ctx = await bootApplication({ sms });
      kit = new MfaTestKit(ctx, '198.33');
      freezeTime(kit.clock);
      kit.nextStepStart();
    });

    afterAll(async () => {
      jest.useRealTimers();
      await ctx?.close();
    });

    // Far apart: limits and tokens of other tests never matter.
    beforeEach(() => kit.nextStepStart(60 * MIN));

    const http = () => kit.http();

    /** A fresh authenticator code (the next 30-second step, never used). */
    const freshCode = (user: TestUser) => {
      kit.nextStepStart();
      return totpCode(user.totpSecret as string, kit.clock);
    };

    async function mfaUser(): Promise<MfaUser> {
      const user = await kit.createUser();
      const { recoveryCodes } = await kit.enableMfa(user);
      return { ...user, recoveryCodes };
    }

    /** Password sign-in of an MFA user: a new challenge token. */
    const challengeOf = async (user: TestUser) => {
      const body = dataOf<Tokens>(await kit.login(user).expect(201));
      expect(body.mfaRequired).toBe(true);
      return body.challengeToken as string;
    };

    const complete = (user: TestUser, body: Record<string, unknown>) =>
      http().post('/auth/login/mfa').set('X-Forwarded-For', user.ip).send(body);

    const stepUp = (user: TestUser, body: Record<string, unknown>) =>
      http().post('/auth/step-up').set(kit.as(user)).send(body);

    const usedRecoveryCodes = (user: TestUser) =>
      ctx.client.mfaRecoveryCode.count({
        where: { authId: user.id, usedAt: { not: null } },
      });
    const activeSessions = (user: TestUser) =>
      ctx.client.refreshSession.findMany({
        where: { authId: user.id, revokedAt: null },
        select: { familyId: true, mfaVerifiedWith: true },
      });
    const approvalsOf = (user: TestUser) =>
      ctx.client.stepUpApproval.count({ where: { authId: user.id } });

    describe('one credential, many concurrent requests', () => {
      it('a recovery code is accepted exactly once across sign-in, verification and step-up', async () => {
        const user = await mfaUser();
        const [first, second] = [
          await challengeOf(user),
          await challengeOf(user),
        ];
        const code = user.recoveryCodes[0];
        const sessionsBefore = (await activeSessions(user)).length;
        const approvalsBefore = await approvalsOf(user);

        const responses = await Promise.all([
          complete(user, { challengeToken: first, recoveryCode: code }),
          complete(user, { challengeToken: second, recoveryCode: code }),
          kit.verify(user, { recoveryCode: code }),
          stepUp(user, { action: 'DATA_EXPORT', recoveryCode: code }),
        ]);

        expect(responses.filter(isSuccess)).toHaveLength(1);
        for (const response of responses.filter((r) => !isSuccess(r))) {
          expect(response.status).toBe(400);
        }
        expect(await usedRecoveryCodes(user)).toBe(1);
        const [signInA, signInB, , approval] = responses;
        expect((await activeSessions(user)).length).toBe(
          sessionsBefore + [signInA, signInB].filter(isSuccess).length,
        );
        expect(await approvalsOf(user)).toBe(
          approvalsBefore + (isSuccess(approval) ? 1 : 0),
        );
        // Used: it never works again.
        await kit.verify(user, { recoveryCode: code }).expect(400);
      });

      it('an authenticator code is accepted exactly once across sign-in, verification and step-up', async () => {
        const user = await mfaUser();
        const [first, second] = [
          await challengeOf(user),
          await challengeOf(user),
        ];
        const code = freshCode(user);

        const responses = await Promise.all([
          complete(user, { challengeToken: first, code }),
          complete(user, { challengeToken: second, code }),
          kit.verify(user, { code }),
          stepUp(user, { action: 'DATA_EXPORT', code }),
        ]);

        expect(responses.filter(isSuccess)).toHaveLength(1);
        const step = Math.floor(kit.clock.getTime() / 30_000);
        expect(
          (
            await ctx.client.authSecurity.findUniqueOrThrow({
              where: { authId: user.id },
            })
          ).mfaLastUsedStep,
        ).toBe(step);
        // Replayed later in the same step: refused.
        await kit.verify(user, { code }).expect(400);
      });

      it('an MFA challenge is completed once, whichever factors race for it', async () => {
        const user = await mfaUser();
        const challengeToken = await challengeOf(user);
        const code = freshCode(user);

        const responses = await Promise.all([
          complete(user, { challengeToken, code }),
          ...user.recoveryCodes
            .slice(0, 3)
            .map((recoveryCode) =>
              complete(user, { challengeToken, recoveryCode }),
            ),
        ]);

        const winners = responses.filter(isSuccess);
        expect(winners).toHaveLength(1);
        expect(responses.filter((r) => r.status === 401)).toHaveLength(3);
        // Only the winner's factor was consumed.
        const method = dataOf<Tokens>(winners[0]).mfaMethod;
        expect(await usedRecoveryCodes(user)).toBe(
          method === 'recovery_code' ? 1 : 0,
        );
        expect(
          await ctx.client.mfaLoginChallenge.count({
            where: { authId: user.id, consumedAt: { not: null } },
          }),
        ).toBe(1);
      });

      it('concurrent step-ups with one code create one approval', async () => {
        const user = await mfaUser();
        const code = freshCode(user);
        const before = await approvalsOf(user);

        const responses = await Promise.all(
          ['DATA_EXPORT', 'ACCOUNT_DELETION', 'MFA_DISABLE', 'DATA_EXPORT'].map(
            (action) => stepUp(user, { action, code }),
          ),
        );

        expect(responses.filter(isSuccess)).toHaveLength(1);
        expect(await approvalsOf(user)).toBe(before + 1);
      });
    });

    describe('changes racing with use', () => {
      it('recovery codes regenerated while an old code is used: old codes never work afterwards', async () => {
        const user = await mfaUser();
        const approval = await kit.approve(user, 'MFA_RECOVERY_CODES');
        const old = user.recoveryCodes[1];

        const [regenerated, used] = await Promise.all([
          http()
            .post('/auth/mfa/recovery-codes')
            .set(kit.as(user))
            .set(HEADER, approval),
          kit.verify(user, { recoveryCode: old }),
        ]);

        expect(regenerated.status).toBe(201);
        expect([200, 400]).toContain(used.status);
        const fresh = dataOf<{ recoveryCodes: string[] }>(
          regenerated,
        ).recoveryCodes;
        // Whatever the order, afterwards only the ten new codes exist.
        expect(
          await ctx.client.mfaRecoveryCode.count({
            where: { authId: user.id, usedAt: null },
          }),
        ).toBe(10);
        expect(
          await ctx.client.mfaRecoveryCode.count({
            where: { authId: user.id },
          }),
        ).toBe(10);
        for (const code of user.recoveryCodes.slice(2, 4)) {
          await kit.verify(user, { recoveryCode: code }).expect(400);
        }
        await kit.verify(user, { recoveryCode: fresh[0] }).expect(200);
      });

      it('MFA disabled while the authenticator is replaced: one consistent end state', async () => {
        const user = await mfaUser();
        const replaceApproval = await kit.approve(
          user,
          'MFA_AUTHENTICATOR_REPLACE',
        );
        const disableApproval = await kit.approve(user, 'MFA_DISABLE');
        const started = dataOf<{ secret: string }>(
          await http()
            .post('/auth/mfa/authenticator/replacement')
            .set(kit.as(user))
            .set(HEADER, replaceApproval)
            .expect(201),
        );
        kit.nextStepStart();

        const [replaced, disabled] = await Promise.all([
          http()
            .post('/auth/mfa/authenticator/replacement/confirm')
            .set(kit.as(user))
            .set(HEADER, replaceApproval)
            .send({ code: totpCode(started.secret, kit.clock) }),
          http()
            .post('/auth/mfa/disable')
            .set(kit.as(user))
            .set(HEADER, disableApproval),
        ]);

        expect(disabled.status).toBe(200);
        expect([200, 403, 409]).toContain(replaced.status);
        // MFA is off, and nothing of it is left anywhere.
        const where = { where: { authId: user.id } };
        expect(
          await ctx.client.authSecurity.findUniqueOrThrow(where),
        ).toMatchObject({
          mfaEnabled: false,
          mfaMethod: null,
          mfaSecret: null,
        });
        expect(await ctx.client.mfaRecoveryCode.count(where)).toBe(0);
        expect(await ctx.client.mfaEnrollment.count(where)).toBe(0);
        expect(
          await ctx.client.mfaTrustedDevice.count({
            where: { authId: user.id, revokedAt: null },
          }),
        ).toBe(0);
      });

      it('concurrent enrollment starts: only the secret that remains can be confirmed', async () => {
        const user = await kit.createUser();
        const approval = await kit.approve(user, 'MFA_ENROLLMENT');

        const starts = await Promise.all(
          Array.from({ length: 3 }, () =>
            http()
              .post('/auth/mfa/enrollment')
              .set(kit.as(user))
              .set(HEADER, approval),
          ),
        );
        expect(starts.map((r) => r.status)).toEqual([201, 201, 201]);
        const secrets = starts.map((r) => dataOf<{ secret: string }>(r).secret);
        expect(new Set(secrets).size).toBe(3);

        const results: number[] = [];
        for (const secret of secrets) {
          const response = await kit.confirm(
            user,
            totpCode(secret, kit.clock),
            approval,
          );
          results.push(response.status);
          if (response.status === 200) break;
        }
        expect(results.filter((s) => s === 200)).toHaveLength(1);
        expect(results.filter((s) => s !== 200).every((s) => s === 400)).toBe(
          true,
        );
      });

      /**
       * Holds the next sign-in between its MFA decision (the gate) and storing
       * its session, until `release` resolves: the worst moment for a change
       * of MFA state to land.
       */
      function holdNextSignInAfterGate(release: Promise<unknown>) {
        const service = ctx.get<MfaLoginService>(MfaLoginService);
        const gate = service.gate.bind(service) as MfaLoginService['gate'];
        jest
          .spyOn(service, 'gate')
          .mockImplementationOnce(async (input, now) => {
            const decision = await gate(input, now);
            await release;
            return decision;
          });
      }

      it('a password sign-in that passed the MFA gate just before MFA was enabled gets no session', async () => {
        const user = await kit.createUser();
        const activating = sidOf(user.accessToken);
        const approval = await kit.approve(user, 'MFA_ENROLLMENT');
        const { secret } = dataOf<{ secret: string }>(
          await kit.start(user, approval).expect(201),
        );
        let enable!: () => void;
        const enabled = new Promise<void>((resolve) => (enable = resolve));
        holdNextSignInAfterGate(enabled);

        // The sign-in decides "no MFA needed", then MFA is enabled (ending
        // every other session), then the sign-in tries to store its session.
        const login = kit.login(user).then((r) => r);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await kit
          .confirm(user, totpCode(secret, kit.clock), approval)
          .expect(200);
        enable();

        const refused = await login;
        expect(refused.status).toBe(409);
        expect((await activeSessions(user)).map((s) => s.familyId)).toEqual([
          activating,
        ]);
      });

      it('a password sign-in racing with MFA activation never keeps a session without MFA', async () => {
        for (let round = 0; round < 3; round++) {
          const user = await kit.createUser();
          const activating = sidOf(user.accessToken);
          const approval = await kit.approve(user, 'MFA_ENROLLMENT');
          const { secret } = dataOf<{ secret: string }>(
            await kit.start(user, approval).expect(201),
          );

          const [confirmed, login] = await Promise.all([
            kit.confirm(user, totpCode(secret, kit.clock), approval),
            kit.login(user),
          ]);

          expect(confirmed.status).toBe(200);
          // The sign-in either needed MFA, was refused, or its session was
          // ended by the activation: never an active session without MFA.
          expect([201, 409]).toContain(login.status);
          expect((await activeSessions(user)).map((s) => s.familyId)).toEqual([
            activating,
          ]);
          kit.advance(SECOND);
        }
      });

      it('a trusted-device sign-in whose device is revoked before its session is stored gets no session', async () => {
        const user = await mfaUser();
        const trusted = dataOf<Tokens>(
          await complete(user, {
            challengeToken: await challengeOf(user),
            code: freshCode(user),
            trustDevice: true,
          }).expect(200),
        );
        const device = trusted.trustedDevice as { id: string; token: string };
        const sessionsBefore = (await activeSessions(user)).length;
        let revoke!: () => void;
        const revokedNow = new Promise<void>((resolve) => (revoke = resolve));
        holdNextSignInAfterGate(revokedNow);

        const login = kit
          .login({ ...user, trustedDeviceToken: device.token })
          .then((r) => r);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await http()
          .delete(`/auth/mfa/trusted-devices/${device.id}`)
          .set(kit.as(user))
          .expect(200);
        revoke();

        expect((await login).status).toBe(409);
        expect((await activeSessions(user)).length).toBe(sessionsBefore);
      });

      it('a trusted device revoked while it signs in never skips MFA afterwards', async () => {
        const user = await mfaUser();
        const challengeToken = await challengeOf(user);
        const trusted = dataOf<Tokens>(
          await complete(user, {
            challengeToken,
            code: freshCode(user),
            trustDevice: true,
          }).expect(200),
        );
        const device = trusted.trustedDevice as { id: string; token: string };
        const onDevice = { ...user, trustedDeviceToken: device.token };

        const [revoked, login] = await Promise.all([
          http()
            .delete(`/auth/mfa/trusted-devices/${device.id}`)
            .set(kit.as(user)),
          kit.login(onDevice),
        ]);

        expect(revoked.status).toBe(200);
        expect([201, 409]).toContain(login.status);
        // Afterwards the device never skips MFA again.
        kit.advance(SECOND);
        const again = dataOf<Tokens>(await kit.login(onDevice).expect(201));
        expect(again.mfaRequired).toBe(true);
        const row = await ctx.client.mfaTrustedDevice.findUniqueOrThrow({
          where: { id: device.id },
        });
        expect(row.revokedAt).not.toBeNull();
      });

      it('concurrent revocations of one session succeed once', async () => {
        const user = await kit.createUser();
        const other = { ...user };
        await kit.signIn(other);
        const sid = sidOf(other.accessToken);

        const responses = await Promise.all(
          Array.from({ length: 5 }, () =>
            http().delete(`/auth/sessions/${sid}`).set(kit.as(user)),
          ),
        );

        expect(responses.map((r) => r.status).sort()).toEqual([
          200, 404, 404, 404, 404,
        ]);
        expect(
          await ctx.client.securityEvent.count({
            where: { authId: user.id, type: 'SESSION_REVOKED' },
          }),
        ).toBe(1);
        await http().get('/auth/mfa').set(kit.as(other)).expect(401);
      });
    });

    describe('SMS limits under concurrent requests', () => {
      const newNumber = () => `+3361234${String(1000 + ++numbers).slice(-4)}`;

      async function phoneUser() {
        const user = await mfaUser();
        const phone = newNumber();
        await http()
          .post('/auth/mfa/sms/enrollment')
          .set(kit.as(user))
          .set(HEADER, await kit.approve(user, 'MFA_SMS_ENROLLMENT'))
          .send({ phoneNumber: phone })
          .expect(202);
        kit.advance(SECOND);
        await http()
          .post('/auth/mfa/sms/enrollment/confirm')
          .set(kit.as(user))
          .set(HEADER, await kit.approve(user, 'MFA_SMS_ENROLLMENT'))
          .send({ code: sms.lastCodeTo(phone) })
          .expect(200);
        return { ...user, phone };
      }

      const sendSms = (user: TestUser, challengeToken: string) =>
        http()
          .post('/auth/login/mfa/sms')
          .set('X-Forwarded-For', user.ip)
          .send({ challengeToken });

      const securityOf = (user: TestUser) =>
        ctx.client.authSecurity.findUniqueOrThrow({
          where: { authId: user.id },
        });

      it('never sends more than 3 SMS within 15 minutes', async () => {
        const user = await phoneUser(); // 1 sent
        const challengeToken = await challengeOf(user);
        const before = sms.to(user.phone).length;

        const responses = await Promise.all(
          Array.from({ length: 5 }, () => sendSms(user, challengeToken)),
        );

        expect(responses.map((r) => r.status).sort()).toEqual([
          202, 202, 429, 429, 429,
        ]);
        expect(sms.to(user.phone).length - before).toBe(2);
        expect((await securityOf(user)).mfaSmsDeliveriesAt).toHaveLength(3);
        // Exactly one code of the challenge is open (the later send ended the
        // earlier one).
        expect(
          await ctx.client.mfaSmsCode.count({
            where: {
              authId: user.id,
              purpose: 'SIGN_IN',
              usedAt: null,
              invalidatedAt: null,
            },
          }),
        ).toBe(1);
      });

      it('never checks more than 5 SMS codes within 15 minutes', async () => {
        const user = await phoneUser(); // 1 check (the confirmation)
        const challengeToken = await challengeOf(user);
        await sendSms(user, challengeToken).expect(202);
        const code = sms.lastCodeTo(user.phone);

        const responses = await Promise.all(
          Array.from({ length: 7 }, () =>
            complete(user, { challengeToken, smsCode: wrongCode(code) }),
          ),
        );

        expect(responses.map((r) => r.status).sort()).toEqual([
          400, 400, 400, 400, 429, 429, 429,
        ]);
        expect((await securityOf(user)).mfaSmsAttemptsAt).toHaveLength(5);
        // Even the right code is refused now, and stays unused.
        await complete(user, { challengeToken, smsCode: code }).expect(429);
        expect(
          await ctx.client.mfaSmsCode.count({
            where: {
              authId: user.id,
              purpose: 'SIGN_IN',
              usedAt: { not: null },
            },
          }),
        ).toBe(0);
      });

      it('an SMS code completes one sign-in, however many requests race', async () => {
        const user = await phoneUser();
        const challengeToken = await challengeOf(user);
        await sendSms(user, challengeToken).expect(202);
        const smsCode = sms.lastCodeTo(user.phone);
        const sessionsBefore = (await activeSessions(user)).length;

        const responses = await Promise.all(
          Array.from({ length: 3 }, () =>
            complete(user, { challengeToken, smsCode }),
          ),
        );

        expect(responses.filter(isSuccess)).toHaveLength(1);
        expect((await activeSessions(user)).length).toBe(sessionsBefore + 1);
        expect(
          await ctx.client.mfaSmsCode.count({
            where: {
              authId: user.id,
              purpose: 'SIGN_IN',
              usedAt: { not: null },
            },
          }),
        ).toBe(1);
      });
    });

    describe('another user, concurrently', () => {
      it('never completes, verifies or revokes anything of the account', async () => {
        const alice = await mfaUser();
        const mallory = await mfaUser();
        const challengeToken = await challengeOf(alice);
        const malloryTrusted = dataOf<Tokens>(
          await complete(mallory, {
            challengeToken: await challengeOf(mallory),
            code: freshCode(mallory),
            trustDevice: true,
          }).expect(200),
        );
        const aliceTrusted = dataOf<Tokens>(
          await complete(alice, {
            challengeToken: await challengeOf(alice),
            code: freshCode(alice),
            trustDevice: true,
          }).expect(200),
        );
        const aliceSid = sidOf(alice.accessToken);
        kit.nextStepStart();

        const [malloryCode, malloryRecovery, revokeDevice, revokeSession, own] =
          await Promise.all([
            complete(mallory, {
              challengeToken,
              code: totpCode(mallory.totpSecret as string, kit.clock),
            }),
            complete(mallory, {
              challengeToken,
              recoveryCode: mallory.recoveryCodes[0],
            }),
            http()
              .delete(
                `/auth/mfa/trusted-devices/${aliceTrusted.trustedDevice!.id}`,
              )
              .set(kit.as(mallory)),
            http().delete(`/auth/sessions/${aliceSid}`).set(kit.as(mallory)),
            complete(alice, {
              challengeToken,
              code: totpCode(alice.totpSecret as string, kit.clock),
            }),
          ]);

        // Mallory's factors never complete Alice's challenge.
        expect([400, 401]).toContain(malloryCode.status);
        expect([400, 401]).toContain(malloryRecovery.status);
        expect(revokeDevice.status).toBe(404);
        expect(revokeSession.status).toBe(404);
        expect(own.status).toBe(200);
        expect(
          (
            await ctx.client.mfaTrustedDevice.findUniqueOrThrow({
              where: { id: aliceTrusted.trustedDevice!.id },
            })
          ).revokedAt,
        ).toBeNull();
        await http().get('/auth/mfa').set(kit.as(alice)).expect(200);
        // Mallory's own code was not used up by the attempt on Alice.
        await kit
          .verify(mallory, { recoveryCode: mallory.recoveryCodes[0] })
          .expect(200);
        expect(malloryTrusted.trustedDevice).toBeTruthy();
      });
    });

    describe('ended credentials can never become active again (PostgreSQL rules)', () => {
      /** Runs a write that the database must refuse. */
      const refused = (write: Promise<unknown>) =>
        expect(write).rejects.toThrow();

      it('used recovery codes, revoked trusted devices and consumed challenges', async () => {
        const user = await mfaUser();
        await kit
          .verify(user, { recoveryCode: user.recoveryCodes[0] })
          .expect(200);
        const used = await ctx.client.mfaRecoveryCode.findFirstOrThrow({
          where: { authId: user.id, usedAt: { not: null } },
        });
        const challengeToken = await challengeOf(user);
        const trusted = dataOf<Tokens>(
          await complete(user, {
            challengeToken,
            code: freshCode(user),
            trustDevice: true,
          }).expect(200),
        );
        await http()
          .delete(`/auth/mfa/trusted-devices/${trusted.trustedDevice!.id}`)
          .set(kit.as(user))
          .expect(200);
        const consumed = await ctx.client.mfaLoginChallenge.findFirstOrThrow({
          where: { authId: user.id, consumedAt: { not: null } },
        });

        await refused(
          ctx.client.mfaRecoveryCode.update({
            where: { id: used.id },
            data: { usedAt: null },
          }),
        );
        await refused(
          ctx.client.mfaTrustedDevice.update({
            where: { id: trusted.trustedDevice!.id },
            data: { revokedAt: null },
          }),
        );
        await refused(
          ctx.client.mfaTrustedDevice.update({
            where: { id: trusted.trustedDevice!.id },
            data: { expiresAt: new Date(kit.clock.getTime() + 60 * MIN) },
          }),
        );
        await refused(
          ctx.client.mfaLoginChallenge.update({
            where: { id: consumed.id },
            data: { consumedAt: null },
          }),
        );
        await refused(
          ctx.client.mfaLoginChallenge.update({
            where: { id: consumed.id },
            data: { authId: (await kit.createUser()).id },
          }),
        );
      });

      it('expired challenges and approvals cannot be extended', async () => {
        const user = await mfaUser();
        await challengeOf(user);
        kit.advance(6 * MIN);
        const expired = await ctx.client.mfaLoginChallenge.findFirstOrThrow({
          where: { authId: user.id, consumedAt: null },
        });
        await refused(
          ctx.client.mfaLoginChallenge.update({
            where: { id: expired.id },
            data: { expiresAt: new Date(kit.clock.getTime() + MIN) },
          }),
        );
        await kit.signIn(user);
        await kit.approve(user, 'DATA_EXPORT');
        const approval = await ctx.client.stepUpApproval.findFirstOrThrow({
          where: { authId: user.id, action: 'DATA_EXPORT' },
        });
        await refused(
          ctx.client.stepUpApproval.update({
            where: { id: approval.id },
            data: { expiresAt: new Date(approval.createdAt.getTime() + MIN) },
          }),
        );
        await refused(
          ctx.client.stepUpApproval.update({
            where: { id: approval.id },
            data: { action: 'ACCOUNT_DELETION' },
          }),
        );
      });

      it('revoked sessions cannot be restored or extended', async () => {
        const user = await kit.createUser();
        const sid = sidOf(user.accessToken);
        await http().post('/auth/sessions/revoke-all').set(kit.as(user));
        const revoked = await ctx.client.refreshSession.findFirstOrThrow({
          where: { familyId: sid },
        });
        expect(revoked.revokedAt).not.toBeNull();

        await refused(
          ctx.client.refreshSession.update({
            where: { id: revoked.id },
            data: { revokedAt: null, revokedReason: null },
          }),
        );
        await refused(
          ctx.client.refreshSession.update({
            where: { id: revoked.id },
            data: { revokedReason: 'ROTATED' },
          }),
        );
        await refused(
          ctx.client.refreshSession.update({
            where: { id: revoked.id },
            data: { tokenHash: randomBytes(32).toString('hex') },
          }),
        );
      });

      it('SMS codes: ended codes stay ended and undelivered codes are never used', async () => {
        const user = await mfaUser();
        const phone = `+3361299${String(1000 + ++numbers).slice(-4)}`;
        await http()
          .post('/auth/mfa/sms/enrollment')
          .set(kit.as(user))
          .set(HEADER, await kit.approve(user, 'MFA_SMS_ENROLLMENT'))
          .send({ phoneNumber: phone })
          .expect(202);
        kit.advance(SECOND);
        await http()
          .post('/auth/mfa/sms/enrollment/confirm')
          .set(kit.as(user))
          .set(HEADER, await kit.approve(user, 'MFA_SMS_ENROLLMENT'))
          .send({ code: sms.lastCodeTo(phone) })
          .expect(200);
        const used = await ctx.client.mfaSmsCode.findFirstOrThrow({
          where: { authId: user.id, usedAt: { not: null } },
        });
        await refused(
          ctx.client.mfaSmsCode.update({
            where: { id: used.id },
            data: { usedAt: null },
          }),
        );
        // A code whose delivery was never recorded cannot be marked used.
        const undelivered = await ctx.client.mfaSmsCode.create({
          data: {
            id: randomBytes(16).toString('hex'),
            authId: user.id,
            purpose: 'PHONE_REPLACEMENT',
            destination: 'mfa2.pending',
            maskedNumber: '+*******0000',
            codeHash: randomBytes(32).toString('hex'),
            createdAt: kit.clock,
            expiresAt: new Date(kit.clock.getTime() + 5 * MIN),
          },
        });
        await refused(
          ctx.client.mfaSmsCode.update({
            where: { id: undelivered.id },
            data: { usedAt: kit.clock },
          }),
        );
        // Once invalidated, it cannot be delivered (or reopened) any more.
        await ctx.client.mfaSmsCode.update({
          where: { id: undelivered.id },
          data: { invalidatedAt: kit.clock },
        });
        await refused(
          ctx.client.mfaSmsCode.update({
            where: { id: undelivered.id },
            data: { deliveredAt: kit.clock },
          }),
        );
        await refused(
          ctx.client.mfaSmsCode.update({
            where: { id: undelivered.id },
            data: { invalidatedAt: null },
          }),
        );
      });
    });
  },
);
