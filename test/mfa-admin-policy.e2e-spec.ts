// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { AdminMfaGuard } from '../src/auth/admin/admin-mfa.guard';
import { UserRole } from '../src/auth/interfaces/auth.interface';
import { totpCode } from '../src/auth/mfa/mfa-totp';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import type { RateLimitStore } from '../src/infrastructure/rate-limit/rate-limit.store';
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
  type TestUser,
  wrongCode,
} from './support/mfa-e2e';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(120_000);

const HOUR = 60 * MIN;
const ENABLE_MFA =
  'Administrators must enable MFA with an authenticator app before using administrator operations';
const VERIFY_MFA =
  'Verify MFA in this session (POST /auth/mfa/verify) to use administrator operations';
const PLAN = '/v1/admin/subscription-plan';

interface TokensView {
  mfaRequired: boolean;
  accessToken?: string;
  refreshToken?: string;
  challengeToken?: string;
  trustedDevice?: { token: string };
}

/** The `sid` claim of an access token. */
const sidOf = (accessToken: string): string =>
  (
    JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
    ) as { sid: string }
  ).sid;

/**
 * The MFA policy of administrator operations through the real endpoints of
 * the whole application on a temporary, freshly migrated PostgreSQL schema:
 * an ADMIN or SUPERADMIN must have MFA enabled with an authenticator app and
 * must have proved it in the current sign-in session (MFA sign-in, POST
 * /auth/mfa/verify, an MFA step-up or the MFA activation) within the last
 * 12 hours. A trusted device skips MFA at sign-in but never counts as a
 * proof, and no other method (SMS) is accepted. Other users are unaffected.
 */
describeWithDatabase('Administrator MFA policy (e2e, PostgreSQL)', () => {
  let ctx: TestApplication;
  let kit: MfaTestKit;

  beforeAll(async () => {
    ctx = await bootApplication();
    kit = new MfaTestKit(ctx, '198.27');
    freezeTime(kit.clock);
    kit.nextStepStart();
  });

  afterAll(async () => {
    jest.useRealTimers();
    await ctx?.close();
  });

  beforeEach(() => kit.nextStepStart(60 * MIN));

  const http = () => kit.http();

  const getPlan = (user: TestUser) => http().get(PLAN).set(kit.as(user));
  const patchPlan = (user: TestUser, body: object = { trialDays: 10 }) =>
    http().patch(PLAN).set(kit.as(user)).send(body);
  const planRow = () =>
    ctx.client.subscriptionPlan.findUnique({ where: { code: 'PRO' } });

  /** A fresh authenticator code (the next 30-second step, never used). */
  const freshCode = (user: TestUser) => {
    kit.nextStepStart();
    return totpCode(user.totpSecret as string, kit.clock);
  };

  /** A signed-in user with `role` (the token carries the stored role). */
  async function userWithRole(role: UserRole) {
    const user = await kit.createUser();
    await ctx.client.authUser.update({
      where: { id: user.id },
      data: { role },
    });
    await kit.signIn(user);
    return user;
  }

  /**
   * An administrator who enabled MFA (through the API, in the current
   * session); returns the recovery codes too.
   */
  async function mfaAdmin(role: UserRole = UserRole.ADMIN) {
    const user = await userWithRole(role);
    const { recoveryCodes } = await kit.enableMfa(user);
    return { user, recoveryCodes };
  }

  /** Completes a password sign-in with `factor`; returns the tokens. */
  async function mfaSignIn(
    user: TestUser,
    factor: Record<string, unknown>,
  ): Promise<TokensView> {
    const { challengeToken, mfaRequired } = dataOf<TokensView>(
      await kit.login(user).expect(201),
    );
    expect(mfaRequired).toBe(true);
    return dataOf<TokensView>(
      await http()
        .post('/auth/login/mfa')
        .set('X-Forwarded-For', user.ip)
        .send({ challengeToken, ...factor })
        .expect(200),
    );
  }

  /**
   * A session of `user` opened through a trusted device: MFA is skipped at
   * sign-in, so the session has no MFA proof.
   */
  async function trustedDeviceSession(user: TestUser): Promise<TestUser> {
    const trusted = await mfaSignIn(user, {
      code: freshCode(user),
      trustDevice: true,
    });
    const device = {
      ...user,
      trustedDeviceToken: trusted.trustedDevice?.token,
    };
    const skipped = dataOf<TokensView>(await kit.login(device).expect(201));
    expect(skipped.mfaRequired).toBe(false);
    return { ...device, accessToken: skipped.accessToken as string };
  }

  /** The session row's MFA proof. */
  const proofOf = (session: TestUser) =>
    ctx.client.refreshSession.findFirst({
      where: { familyId: sidOf(session.accessToken), revokedAt: null },
      select: { mfaVerifiedAt: true, mfaVerifiedWith: true },
    });

  describe('administrators without MFA', () => {
    it.each([UserRole.ADMIN, UserRole.SUPERADMIN])(
      '%s is refused every administrator operation until MFA is enabled',
      async (role) => {
        const admin = await userWithRole(role);
        const before = await planRow();

        expect(messageOf(await getPlan(admin).expect(403))).toBe(ENABLE_MFA);
        expect(messageOf(await patchPlan(admin).expect(403))).toBe(ENABLE_MFA);
        expect(await planRow()).toEqual(before);

        // Enabling MFA in this session is the proof: the session may
        // administer right away.
        await kit.enableMfa(admin);
        await getPlan(admin).expect(200);
        await patchPlan(admin, { trialDays: 11 }).expect(200);
        expect(await planRow()).toMatchObject({ trialDays: 11 });
        expect(await proofOf(admin)).toEqual({
          mfaVerifiedAt: kit.clock,
          mfaVerifiedWith: 'totp',
        });
      },
    );

    it('a pending (unconfirmed) enrollment is not enough', async () => {
      const admin = await userWithRole(UserRole.ADMIN);
      await kit.start(admin).expect(201);

      expect(messageOf(await getPlan(admin).expect(403))).toBe(ENABLE_MFA);
    });

    it('after MFA is disabled, administrator operations are refused again', async () => {
      const { user: admin } = await mfaAdmin();
      await getPlan(admin).expect(200);

      const approval = await kit.approve(admin, 'MFA_DISABLE');
      await http()
        .post('/auth/mfa/disable')
        .set(kit.as(admin))
        .set('X-Step-Up-Token', approval)
        .expect(200);

      expect(messageOf(await getPlan(admin).expect(403))).toBe(ENABLE_MFA);
    });
  });

  describe('administrators with MFA', () => {
    it('may administer from a session signed in with the authenticator', async () => {
      const { user: admin } = await mfaAdmin(UserRole.SUPERADMIN);

      await kit.signIn(admin); // password + authenticator code

      expect(await proofOf(admin)).toEqual({
        mfaVerifiedAt: kit.clock,
        mfaVerifiedWith: 'totp',
      });
      await patchPlan(admin, { trialDays: 12 }).expect(200);
      expect(
        await ctx.client.activityLogEvent.count({
          where: { tableName: 'SubscriptionPlan', actionedBy: admin.id },
        }),
      ).toBeGreaterThan(0);
    });

    it('may administer from a session signed in with a recovery code', async () => {
      const { user: admin, recoveryCodes } = await mfaAdmin();

      const tokens = await mfaSignIn(admin, { recoveryCode: recoveryCodes[0] });
      const session = { ...admin, accessToken: tokens.accessToken as string };

      expect(await proofOf(session)).toMatchObject({
        mfaVerifiedWith: 'recovery_code',
      });
      await getPlan(session).expect(200);
    });

    it('the proof survives token refreshes of the same session', async () => {
      const { user: admin } = await mfaAdmin();
      const tokens = await mfaSignIn(admin, { code: freshCode(admin) });

      kit.advance(30 * MIN); // the access token has expired
      const refreshed = dataOf<TokensView>(
        await http()
          .post('/auth/refresh-token')
          .set('X-Forwarded-For', admin.ip)
          .send({ refreshToken: tokens.refreshToken })
          .expect(201),
      );

      await getPlan({
        ...admin,
        accessToken: refreshed.accessToken as string,
      }).expect(200);
    });

    it('a proof older than 12 hours no longer counts: verify again', async () => {
      const { user: admin } = await mfaAdmin();
      const tokens = await mfaSignIn(admin, { code: freshCode(admin) });
      const session = { ...admin, accessToken: tokens.accessToken as string };
      await getPlan(session).expect(200);

      let refreshToken = tokens.refreshToken as string;
      const refreshAfter = async (ms: number) => {
        kit.advance(ms);
        const next = dataOf<TokensView>(
          await http()
            .post('/auth/refresh-token')
            .set('X-Forwarded-For', admin.ip)
            .send({ refreshToken })
            .expect(201),
        );
        refreshToken = next.refreshToken as string;
        session.accessToken = next.accessToken as string;
      };

      await refreshAfter(12 * HOUR - MIN);
      await getPlan(session).expect(200);
      await refreshAfter(2 * MIN);
      expect(messageOf(await getPlan(session).expect(403))).toBe(VERIFY_MFA);

      await kit.verify(session, { code: freshCode(admin) }).expect(200);
      await getPlan(session).expect(200);
    });

    it('a token without a sign-in session never carries a proof', async () => {
      const { user: admin } = await mfaAdmin();
      // The activating session is verified; a legacy token of the same
      // account (no session) is not.
      await getPlan(admin).expect(200);
      const { tokenVersion } = await ctx.client.authUser.findUniqueOrThrow({
        where: { id: admin.id },
      });
      const legacy = {
        ...admin,
        accessToken: new AuthUtilsService(
          {} as RateLimitStore,
        ).createAccessToken({
          userId: admin.id,
          role: UserRole.ADMIN,
          tokenVersion,
        }),
      };
      expect(messageOf(await getPlan(legacy).expect(403))).toBe(VERIFY_MFA);
    });

    it('an ended session loses its proof with it', async () => {
      const { user: admin } = await mfaAdmin();
      await getPlan(admin).expect(200);

      await http()
        .delete(`/auth/sessions/${sidOf(admin.accessToken)}`)
        .set(kit.as(admin))
        .expect(200);

      await getPlan(admin).expect(401);
    });
  });

  describe('trusted devices cannot bypass the policy', () => {
    it('a session opened through a trusted device must verify MFA first', async () => {
      const { user: admin } = await mfaAdmin();
      const session = await trustedDeviceSession(admin);

      expect(await proofOf(session)).toEqual({
        mfaVerifiedAt: null,
        mfaVerifiedWith: null,
      });
      expect(messageOf(await getPlan(session).expect(403))).toBe(VERIFY_MFA);
      expect(messageOf(await patchPlan(session).expect(403))).toBe(VERIFY_MFA);

      // A wrong code is no proof...
      await kit
        .verify(session, { code: wrongCode(freshCode(admin)) })
        .expect(400);
      expect(messageOf(await getPlan(session).expect(403))).toBe(VERIFY_MFA);

      // ...the authenticator's code is.
      await kit.verify(session, { code: freshCode(admin) }).expect(200);
      expect(await proofOf(session)).toEqual({
        mfaVerifiedAt: kit.clock,
        mfaVerifiedWith: 'totp',
      });
      await patchPlan(session, { trialDays: 13 }).expect(200);
    });

    it('a recovery code or an MFA step-up in the session is a proof too', async () => {
      const { user: admin, recoveryCodes } = await mfaAdmin();
      const first = await trustedDeviceSession(admin);
      await kit.verify(first, { recoveryCode: recoveryCodes[1] }).expect(200);
      await getPlan(first).expect(200);

      kit.advance(16 * MIN); // (sign-in rate limit: 5 per 15 minutes)
      const second = await trustedDeviceSession(admin);
      await getPlan(second).expect(403);
      await kit.approve(second, 'DATA_EXPORT'); // with the authenticator
      await getPlan(second).expect(200);
    });

    it('the trusted-device header on an administrator request changes nothing', async () => {
      const { user: admin } = await mfaAdmin();
      const session = await trustedDeviceSession(admin);

      await getPlan(session)
        .set('X-MFA-Trusted-Device', session.trustedDeviceToken as string)
        .expect(403);
    });
  });

  describe('no other MFA method is accepted', () => {
    it('an account whose MFA method is SMS is treated as without MFA', async () => {
      const admin = await userWithRole(UserRole.ADMIN);
      await ctx.client.authSecurity.update({
        where: { authId: admin.id },
        data: { mfaEnabled: true, mfaMethod: 'sms', mfaSecret: null },
      });

      expect(messageOf(await getPlan(admin).expect(403))).toBe(ENABLE_MFA);
    });

    it('there is no way to verify with SMS, and a session cannot record an SMS proof', async () => {
      const { user: admin } = await mfaAdmin();
      const session = await trustedDeviceSession(admin);

      await kit.verify(session, { smsCode: '123456' }).expect(400);
      await kit.verify(session, { code: '123456', method: 'sms' }).expect(400);
      await expect(
        ctx.client.refreshSession.updateMany({
          where: { familyId: sidOf(session.accessToken) },
          data: { mfaVerifiedAt: kit.clock, mfaVerifiedWith: 'sms' },
        }),
      ).rejects.toThrow();
      await getPlan(session).expect(403);
    });
  });

  describe('other users', () => {
    it.each([UserRole.USER, UserRole.MODERATOR])(
      '%s is refused by role, not asked for MFA, and keeps using the app without MFA',
      async (role) => {
        const user = await userWithRole(role);

        const refused = await getPlan(user).expect(403);
        expect(messageOf(refused)).not.toBe(ENABLE_MFA);
        expect(messageOf(refused)).not.toBe(VERIFY_MFA);

        await http().get('/v1/subscription').set(kit.as(user)).expect(200);
        await http().get('/auth/sessions').set(kit.as(user)).expect(200);
        await http().get('/auth/mfa').set(kit.as(user)).expect(200);
      },
    );

    it('administrators without MFA still use the non-administrator routes', async () => {
      const admin = await userWithRole(UserRole.ADMIN);

      await http().get('/v1/subscription').set(kit.as(admin)).expect(200);
      await http().get('/auth/mfa').set(kit.as(admin)).expect(200);
    });
  });

  it('every administrator route is protected by the policy', () => {
    const adminRoles: string[] = [UserRole.ADMIN, UserRole.SUPERADMIN];
    const routes: string[] = [];
    for (const module of ctx.get<ModulesContainer>(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as (new () => object) | null;
        if (!controller) continue;
        const prototype = controller.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(prototype)) {
          const handler = prototype[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) {
            continue; // not a route
          }
          const roles = [
            ...((Reflect.getMetadata(ROLES_KEY, handler) as string[]) ?? []),
            ...((Reflect.getMetadata(ROLES_KEY, controller) as string[]) ?? []),
          ];
          if (!roles.some((r) => adminRoles.includes(r))) continue;
          const guards = [
            ...((Reflect.getMetadata(
              GUARDS_METADATA,
              controller,
            ) as unknown[]) ?? []),
            ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ??
              []),
          ];
          routes.push(
            `${String(Reflect.getMetadata(PATH_METADATA, controller))}#${name}`,
          );
          // AuthGuard, then RolesGuard, then the MFA policy.
          expect(guards).toEqual(
            expect.arrayContaining([AuthGuard, RolesGuard, AdminMfaGuard]),
          );
          expect(guards.indexOf(AdminMfaGuard)).toBeGreaterThan(
            guards.indexOf(RolesGuard),
          );
        }
      }
    }
    // The scan found the administrator routes.
    expect(routes).toEqual(
      expect.arrayContaining([
        'v1/admin/subscription-plan#getPlan',
        'v1/admin/subscription-plan#updatePlan',
      ]),
    );
  });
});
