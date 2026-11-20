// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import { randomBytes, randomUUID } from 'node:crypto';
import { UserRole } from '../src/auth/interfaces/auth.interface';
import { totpCode } from '../src/auth/mfa/mfa-totp';
import { AuthUtilsService } from '../src/auth/services/auth-utils.service';
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
  SECOND,
  type TestUser,
  wrongCode,
} from './support/mfa-e2e';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(120_000);

const ENDED = 'This session has ended. Please sign in again.';
const REVOKED = 'Token has been revoked. Please login again.';

/** A sign-in session of a test user: its tokens and its ID (`sid`). */
interface Session extends TestUser {
  refreshToken: string;
  sid: string;
}

interface SessionView {
  id: string;
  current: boolean;
  signedInAt: string;
  lastActiveAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  device: string | null;
  mfaVerifiedAt: string | null;
}

interface RevocationView {
  revoked: number;
  sessionIds: string[];
}

interface ActivityItem {
  type: string;
  sessionId: string | null;
  details: Record<string, unknown>;
}

/** The `sid` claim of an access token. */
const sidOf = (accessToken: string): string =>
  (
    JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
    ) as { sid: string }
  ).sid;

/**
 * Active-session management through the real endpoints of the whole
 * application on a temporary, freshly migrated PostgreSQL schema: users list
 * their own sign-in sessions and end one, all others or all of them. An
 * ended session's access and refresh tokens stop working at once and it can
 * never be refreshed back to life. No user can see or end another user's
 * session. Enabling MFA keeps the session that enables it and ends every
 * other session and credential (approvals, sign-in challenges, trusted
 * devices).
 */
describeWithDatabase(
  'Active sessions and MFA activation (e2e, PostgreSQL)',
  () => {
    let ctx: TestApplication;
    let kit: MfaTestKit;

    beforeAll(async () => {
      ctx = await bootApplication();
      kit = new MfaTestKit(ctx, '198.26');
      freezeTime(kit.clock);
      kit.nextStepStart();
    });

    afterAll(async () => {
      jest.useRealTimers();
      await ctx?.close();
    });

    // Far apart, so sign-in rate limits and tokens of other tests never matter.
    beforeEach(() => kit.nextStepStart(60 * MIN));

    const http = () => kit.http();

    /**
     * A new sign-in session of `user` (password, then the authenticator for
     * MFA users), a little later than the previous one.
     */
    async function signIn(user: TestUser): Promise<Session> {
      kit.advance(2 * SECOND);
      const body = dataOf<{
        mfaRequired: boolean;
        accessToken?: string;
        refreshToken?: string;
        challengeToken?: string;
      }>(await kit.login(user).expect(201));
      let tokens = body;
      if (body.mfaRequired) {
        kit.nextStepStart();
        tokens = dataOf<{ accessToken: string; refreshToken: string }>(
          await http()
            .post('/auth/login/mfa')
            .set('X-Forwarded-For', user.ip)
            .send({
              challengeToken: body.challengeToken,
              code: totpCode(user.totpSecret as string, kit.clock),
            })
            .expect(200),
        ) as typeof body;
      }
      const accessToken = tokens.accessToken as string;
      return {
        ...user,
        accessToken,
        refreshToken: tokens.refreshToken as string,
        sid: sidOf(accessToken),
      };
    }

    /** A new user and `count` sign-in sessions of it. */
    async function userWithSessions(count: number) {
      const user = await kit.createUser();
      const sessions: Session[] = [];
      for (let i = 0; i < count; i++) sessions.push(await signIn(user));
      return { user, sessions };
    }

    const list = async (session: TestUser) =>
      dataOf<SessionView[]>(
        await http().get('/auth/sessions').set(kit.as(session)).expect(200),
      );

    const refresh = (session: Session) =>
      http()
        .post('/auth/refresh-token')
        .set('X-Forwarded-For', session.ip)
        .send({ refreshToken: session.refreshToken });

    /** Proves a session's tokens are accepted (access token and refresh). */
    async function expectActive(session: Session) {
      await http().get('/auth/mfa').set(kit.as(session)).expect(200);
      const rotated = dataOf<{ accessToken: string; refreshToken: string }>(
        await refresh(session).expect(201),
      );
      // The refreshed tokens belong to the same session.
      expect(sidOf(rotated.accessToken)).toBe(session.sid);
      session.accessToken = rotated.accessToken;
      session.refreshToken = rotated.refreshToken;
    }

    /**
     * Proves a session's tokens are refused, at once and for good. (Ending
     * all sessions also changes the token version, which AuthGuard checks
     * first: `message`.)
     */
    async function expectEnded(session: Session, message = ENDED) {
      const refused = await http()
        .get('/auth/mfa')
        .set(kit.as(session))
        .expect(401);
      expect(messageOf(refused)).toBe(message);
      if (session.refreshToken) await refresh(session).expect(401);
      expect(
        await ctx.client.refreshSession.count({
          where: { familyId: session.sid, revokedAt: null },
        }),
      ).toBe(0);
    }

    const activityOf = async (session: TestUser) =>
      dataOf<{ items: ActivityItem[] }>(
        await http()
          .get('/v1/security/activity')
          .set(kit.as(session))
          .expect(200),
      ).items;

    describe('listing', () => {
      it('shows the owner’s active sessions only, marks the current one and never exposes a token', async () => {
        const { user, sessions } = await userWithSessions(3);
        const [a, b, c] = sessions;
        const other = await userWithSessions(1);

        const response = await http()
          .get('/auth/sessions')
          .set(kit.as(a))
          .expect(200);

        expect(response.headers['cache-control']).toBe('no-store');
        const views = dataOf<SessionView[]>(response);
        // The session kit.createUser() signed in with, plus a, b and c.
        expect(views).toHaveLength(4);
        expect(views.map((v) => v.id)).toEqual(
          expect.arrayContaining([
            a.sid,
            b.sid,
            c.sid,
            sidOf(user.accessToken),
          ]),
        );
        expect(views.map((v) => v.id)).not.toContain(other.sessions[0].sid);
        expect(views.filter((v) => v.current).map((v) => v.id)).toEqual([
          a.sid,
        ]);
        const viewOfA = views.find((v) => v.id === a.sid) as SessionView;
        expect(viewOfA).toEqual({
          id: a.sid,
          current: true,
          signedInAt: expect.any(String) as string,
          lastActiveAt: expect.any(String) as string,
          expiresAt: expect.any(String) as string,
          ipAddress: user.ip,
          userAgent: expect.any(String) as string,
          device: null,
          mfaVerifiedAt: null,
        });
        // Most recently active first.
        expect(views.map((v) => v.id).slice(0, 3)).toEqual([
          c.sid,
          b.sid,
          a.sid,
        ]);
        const text = JSON.stringify(response.body);
        for (const session of sessions) {
          expect(text).not.toContain(session.refreshToken);
          expect(text).not.toContain(session.accessToken);
        }
        expect(text).not.toMatch(/tokenHash|tokenId|refreshToken/);

        // The other user sees only their own (two: createUser's and theirs).
        const theirs = await list(other.sessions[0]);
        expect(theirs.map((v) => v.id)).not.toEqual(
          expect.arrayContaining([a.sid]),
        );
        expect(theirs).toHaveLength(2);
      });

      it('keeps a session’s ID across refreshes and lists it once', async () => {
        const { sessions } = await userWithSessions(1);
        const [a] = sessions;
        const signedInAt = (await list(a)).find(
          (v) => v.id === a.sid,
        )?.signedInAt;

        kit.advance(MIN);
        await expectActive(a);
        kit.advance(MIN);
        await expectActive(a);

        const views = await list(a);
        const viewsOfA = views.filter((v) => v.id === a.sid);
        expect(viewsOfA).toHaveLength(1);
        expect(viewsOfA[0]).toMatchObject({
          current: true,
          signedInAt,
          lastActiveAt: kit.clock.toISOString(),
        });
      });

      it('needs a valid access token', async () => {
        await http().get('/auth/sessions').expect(401);
        await http()
          .get('/auth/sessions')
          .set('Authorization', 'Bearer not-a-token')
          .expect(401);
      });
    });

    describe('ending one session', () => {
      it('revokes its access and refresh tokens at once; other sessions keep working', async () => {
        const { sessions } = await userWithSessions(3);
        const [a, b, c] = sessions;
        // b refreshed once: its earlier refresh token is already rotated.
        const earlier = { ...b };
        await expectActive(b);

        const response = await http()
          .delete(`/auth/sessions/${b.sid}`)
          .set(kit.as(a))
          .expect(200);

        expect(dataOf<RevocationView>(response)).toEqual({
          revoked: 1,
          sessionIds: [b.sid],
        });
        await expectEnded(b);
        // Neither the current nor an earlier refresh token brings it back.
        await refresh(earlier).expect(401);
        await http().get('/auth/mfa').set(kit.as(earlier)).expect(401);
        expect(
          await ctx.client.refreshSession.findMany({
            where: { familyId: b.sid, revokedReason: 'USER_REVOKED' },
            select: { revokedAt: true },
          }),
        ).toEqual([{ revokedAt: kit.clock }]);
        expect((await list(a)).map((v) => v.id)).not.toContain(b.sid);

        await expectActive(a);
        await expectActive(c);

        // Ending it again: it is no longer an active session.
        await http()
          .delete(`/auth/sessions/${b.sid}`)
          .set(kit.as(a))
          .expect(404);
      });

      it('can end the current session itself', async () => {
        const { sessions } = await userWithSessions(2);
        const [a, b] = sessions;

        await http()
          .delete(`/auth/sessions/${a.sid}`)
          .set(kit.as(a))
          .expect(200);

        await expectEnded(a);
        await expectActive(b);
      });

      it('never reveals or ends another user’s session', async () => {
        const owner = await userWithSessions(1);
        const [victim] = owner.sessions;
        const attacker = await userWithSessions(1);
        const [mine] = attacker.sessions;

        const refused = await http()
          .delete(`/auth/sessions/${victim.sid}`)
          .set(kit.as(mine))
          .expect(404);
        // The same answer as for a session that does not exist at all.
        const unknown = await http()
          .delete(`/auth/sessions/${randomUUID()}`)
          .set(kit.as(mine))
          .expect(404);
        expect(messageOf(refused)).toBe(messageOf(unknown));
        // "Others" and "all" only ever mean the caller's own sessions.
        await http()
          .post('/auth/sessions/revoke-others')
          .set(kit.as(mine))
          .expect(200);
        await http()
          .post('/auth/sessions/revoke-all')
          .set(kit.as(mine))
          .send({ userId: owner.user.id })
          .expect(400);

        await expectActive(victim);
        expect((await list(victim)).map((v) => v.id)).toContain(victim.sid);
        // The attacker's history records nothing about the victim.
        expect(JSON.stringify(await activityOf(mine))).not.toContain(
          victim.sid,
        );
      });

      it('validates the session ID and needs authentication', async () => {
        const { sessions } = await userWithSessions(1);
        await http()
          .delete('/auth/sessions/not-a-uuid')
          .set(kit.as(sessions[0]))
          .expect(400);
        await http().delete(`/auth/sessions/${sessions[0].sid}`).expect(401);
        await expectActive(sessions[0]);
      });
    });

    describe('ending the other sessions', () => {
      it('keeps the current session and ends every other one', async () => {
        const { user, sessions } = await userWithSessions(3);
        const [a, b, c] = sessions;

        const response = await http()
          .post('/auth/sessions/revoke-others')
          .set(kit.as(a))
          .expect(200);

        const result = dataOf<RevocationView>(response);
        expect(result.revoked).toBe(3);
        expect([...result.sessionIds].sort()).toEqual(
          [b.sid, c.sid, sidOf(user.accessToken)].sort(),
        );
        await expectEnded(b);
        await expectEnded(c);
        await expectActive(a);
        expect((await list(a)).map((v) => v.id)).toEqual([a.sid]);

        // Nothing left to end.
        expect(
          dataOf<RevocationView>(
            await http()
              .post('/auth/sessions/revoke-others')
              .set(kit.as(a))
              .expect(200),
          ),
        ).toEqual({ revoked: 0, sessionIds: [] });
      });

      it('a refresh racing the revocation cannot keep a session alive', async () => {
        const { sessions } = await userWithSessions(2);
        const [a, b] = sessions;

        const [revoked, refreshed] = await Promise.all([
          http().post('/auth/sessions/revoke-others').set(kit.as(a)),
          refresh(b),
        ]);

        expect(revoked.status).toBe(200);
        if (refreshed.status === 201) {
          // The refresh won: its new tokens were ended with the session.
          const tokens = dataOf<{ accessToken: string; refreshToken: string }>(
            refreshed,
          );
          b.accessToken = tokens.accessToken;
          b.refreshToken = tokens.refreshToken;
        } else {
          expect(refreshed.status).toBe(401);
        }
        await expectEnded(b);
        await expectActive(a);
      });
    });

    describe('ending all sessions', () => {
      it('ends every session and every access token, the current one included', async () => {
        const { user, sessions } = await userWithSessions(2);
        const [a, b] = sessions;
        // A token issued before sessions were identified (no `sid`) is ended
        // too: the token version changes.
        const { tokenVersion } = await ctx.client.authUser.findUniqueOrThrow({
          where: { id: user.id },
        });
        const legacy = {
          ...user,
          accessToken: new AuthUtilsService(
            {} as RateLimitStore,
          ).createAccessToken({
            userId: user.id,
            role: UserRole.USER,
            tokenVersion,
          }),
        };
        await http().get('/auth/mfa').set(kit.as(legacy)).expect(200);

        const response = await http()
          .post('/auth/sessions/revoke-all')
          .set(kit.as(a))
          .expect(200);

        expect(dataOf<RevocationView>(response).revoked).toBe(3);
        await expectEnded(a, REVOKED);
        await expectEnded(b, REVOKED);
        await http().get('/auth/mfa').set(kit.as(legacy)).expect(401);

        // Signing in again starts a new, working session.
        const fresh = await signIn(user);
        await expectActive(fresh);
        expect((await list(fresh)).map((v) => v.id)).toEqual([fresh.sid]);
      });

      it('POST /auth/logout-all does the same', async () => {
        const { sessions } = await userWithSessions(2);
        const [a, b] = sessions;

        await http().post('/auth/logout-all').set(kit.as(a)).expect(201);

        await expectEnded(a, REVOKED);
        await expectEnded(b, REVOKED);
      });

      it('POST /auth/logout ends only that session, access token included', async () => {
        const { sessions } = await userWithSessions(2);
        const [a, b] = sessions;

        await http()
          .post('/auth/logout')
          .set(kit.as(a))
          .send({ refreshToken: a.refreshToken })
          .expect(201);

        await expectEnded(a);
        await expectActive(b);
      });

      it('rejects a request body', async () => {
        const { sessions } = await userWithSessions(1);
        await http()
          .post('/auth/sessions/revoke-all')
          .set(kit.as(sessions[0]))
          .send({ keep: sessions[0].sid })
          .expect(400);
        await expectActive(sessions[0]);
      });
    });

    describe('enabling MFA', () => {
      it('keeps the activating session and ends every other session and credential', async () => {
        const { user, sessions } = await userWithSessions(2);
        const [a, b] = sessions;
        // Credentials of the other sessions: a step-up approval of b, and a
        // trusted device left from an earlier MFA setup.
        await kit.approve(b, 'DATA_EXPORT');
        await ctx.client.mfaTrustedDevice.create({
          data: {
            authId: user.id,
            tokenHash: randomBytes(32).toString('hex'),
            name: 'old phone',
            createdAt: kit.clock,
            expiresAt: new Date(kit.clock.getTime() + 30 * 24 * 60 * MIN),
          },
        });

        const { response } = await kit.enableMfa(a);

        expect(
          dataOf<{ sessionsRevoked: number }>(response).sessionsRevoked,
        ).toBe(2);
        await expectEnded(b);
        await expectEnded({
          ...user,
          refreshToken: '', // (not known to the test)
          sid: sidOf(user.accessToken),
        });
        expect(
          await ctx.client.stepUpApproval.count({
            where: { authId: user.id, sessionId: b.sid },
          }),
        ).toBe(0);
        expect(
          await ctx.client.mfaTrustedDevice.findMany({
            where: { authId: user.id },
            select: { revokedAt: true },
          }),
        ).toEqual([{ revokedAt: kit.clock }]);
        expect(
          await ctx.client.refreshSession.findMany({
            where: { familyId: b.sid },
            select: { revokedReason: true },
          }),
        ).toEqual([{ revokedReason: 'MFA_ENABLED' }]);

        // The activating session stays signed in, MFA-verified, also after a
        // refresh.
        await expectActive(a);
        const [view] = await list(a);
        expect(view).toMatchObject({
          id: a.sid,
          current: true,
          mfaVerifiedAt: kit.clock.toISOString(),
        });

        // Whoever held b must now prove MFA to sign in again.
        const login = dataOf<{ mfaRequired: boolean }>(
          await kit.login(user).expect(201),
        );
        expect(login.mfaRequired).toBe(true);

        // Recorded in the history.
        const types = (await activityOf(a)).map((e) => e.type);
        expect(types).toEqual(
          expect.arrayContaining([
            'MFA_ENABLED',
            'SESSION_REVOKED',
            'TRUSTED_DEVICE_REVOKED',
          ]),
        );
        const revocation = (await activityOf(a)).find(
          (e) => e.type === 'SESSION_REVOKED',
        ) as ActivityItem;
        expect(revocation).toMatchObject({
          sessionId: a.sid,
          details: {
            scope: 'mfa_enabled',
            count: 2,
            includesCurrentSession: false,
          },
        });
      });

      it('with a single session ends nothing else', async () => {
        const user = await kit.createUser();

        const { response } = await kit.enableMfa(user);

        expect(
          dataOf<{ sessionsRevoked: number }>(response).sessionsRevoked,
        ).toBe(0);
        await http().get('/auth/mfa').set(kit.as(user)).expect(200);
      });

      it('a failed confirmation ends nothing', async () => {
        const { sessions } = await userWithSessions(2);
        const [a, b] = sessions;
        const { secret } = dataOf<{ secret: string }>(
          await kit.start(a).expect(201),
        );
        await kit
          .confirm(a, wrongCode(totpCode(secret, kit.clock)))
          .expect(400);

        await expectActive(b);
        await expectActive(a);
      });
    });
  },
);
