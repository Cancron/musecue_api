import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuthChallengeRepository } from '../src/auth/state/auth-challenge.repository';
import { OAuthStateRepository } from '../src/auth/state/oauth-state.repository';
import {
  LoginInProgressError,
  RefreshSessionRepository,
  type NewRefreshSession,
} from '../src/auth/state/refresh-session.repository';
import config from '../src/common/config/app.config';
import type { PrismaService } from '../src/common/services/prisma.service';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  connectToSchema,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';

jest.setTimeout(60_000);

const HOUR = 3_600_000;

/**
 * Authentication security state in PostgreSQL (used in both infrastructure
 * modes): refresh sessions, one-time codes and OAuth states, against the
 * migrated schema.
 */
describeWithDatabase('Authentication state (PostgreSQL)', () => {
  let schema: string;
  let client: PrismaClient;
  let prisma: PrismaService;
  let sessions: RefreshSessionRepository;
  let challenges: AuthChallengeRepository;
  let oauthStates: OAuthStateRepository;
  const originalSecret = config.jwt_refresh_secret;

  beforeAll(async () => {
    config.jwt_refresh_secret = 'auth-state-e2e-refresh-secret';
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    client = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: TEST_DATABASE_URL as string,
          options: `-c search_path=${schema}`,
        },
        { schema },
      ),
    });
    prisma = client as unknown as PrismaService;
    sessions = new RefreshSessionRepository(prisma);
    challenges = new AuthChallengeRepository(prisma);
    oauthStates = new OAuthStateRepository(prisma);
  });

  afterAll(async () => {
    config.jwt_refresh_secret = originalSecret;
    await client?.$disconnect();
    if (schema) await dropSchema(schema);
  });

  async function createUser(): Promise<string> {
    const tag = randomBytes(5).toString('hex');
    const user = await client.authUser.create({
      data: { email: `${tag}@example.com`, username: `u_${tag}`, password: '' },
    });
    return user.id;
  }

  const session = (
    authId: string,
    overrides: Partial<NewRefreshSession> = {},
  ): NewRefreshSession => {
    const tokenId = randomBytes(32).toString('hex');
    return {
      authId,
      sessionId: randomUUID(),
      tokenId,
      tokenHash: createHash('sha256').update(`token-${tokenId}`).digest('hex'),
      ipAddress: '203.0.113.7',
      userAgent: 'e2e',
      device: 'phone',
      expiresAt: new Date(Date.now() + 7 * 24 * HOUR),
      ...overrides,
    };
  };
  const activeSessions = (authId: string) =>
    client.refreshSession.findMany({
      where: { authId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
    });

  describe('refresh sessions', () => {
    it('stores only the token hash with device metadata and an expiry', async () => {
      const authId = await createUser();
      const login = session(authId);

      await sessions.createForLogin(login, 5);

      const stored = await client.refreshSession.findUniqueOrThrow({
        where: { tokenId: login.tokenId },
      });
      expect(stored).toMatchObject({
        authId,
        tokenHash: login.tokenHash,
        ipAddress: '203.0.113.7',
        userAgent: 'e2e',
        device: 'phone',
        revokedAt: null,
        rotatedFromId: null,
      });
      await expect(sessions.find(login.tokenId)).resolves.toMatchObject({
        authId,
        tokenHash: login.tokenHash,
        revokedAt: null,
      });
    });

    it('rotates once, recording the lineage, and rejects reuse of the old token', async () => {
      const authId = await createUser();
      const login = session(authId);
      await sessions.createForLogin(login, 5);
      const next = session(authId);

      await expect(
        sessions.rotate(
          { authId, tokenId: login.tokenId, tokenHash: login.tokenHash },
          next,
        ),
      ).resolves.toBe(true);

      const [old, replacement] = await Promise.all([
        client.refreshSession.findUniqueOrThrow({
          where: { tokenId: login.tokenId },
        }),
        client.refreshSession.findUniqueOrThrow({
          where: { tokenId: next.tokenId },
        }),
      ]);
      expect(old.revokedReason).toBe('ROTATED');
      expect(old.revokedAt).toBeInstanceOf(Date);
      expect(replacement.rotatedFromId).toBe(old.id);
      expect(replacement.revokedAt).toBeNull();

      // Reusing the rotated token fails and creates nothing.
      await expect(
        sessions.rotate(
          { authId, tokenId: login.tokenId, tokenHash: login.tokenHash },
          session(authId),
        ),
      ).resolves.toBe(false);
      expect((await activeSessions(authId)).map((s) => s.tokenId)).toEqual([
        next.tokenId,
      ]);
    });

    it('lets exactly one of concurrent rotations of the same token succeed', async () => {
      const authId = await createUser();
      const login = session(authId);
      await sessions.createForLogin(login, 5);
      const current = {
        authId,
        tokenId: login.tokenId,
        tokenHash: login.tokenHash,
      };

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          sessions.rotate(current, session(authId)),
        ),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      const active = await activeSessions(authId);
      expect(active).toHaveLength(1);
      expect(active[0].rotatedFromId).toEqual(expect.any(String));
    });

    it('refuses to rotate with a wrong hash, another owner, or after expiry', async () => {
      const authId = await createUser();
      const other = await createUser();
      const login = session(authId);
      const expired = session(authId, {
        expiresAt: new Date(Date.now() + 1_000),
      });
      await sessions.createForLogin(login, 5);
      await sessions.createForLogin(expired, 5);

      await expect(
        sessions.rotate(
          { authId, tokenId: login.tokenId, tokenHash: 'f'.repeat(64) },
          session(authId),
        ),
      ).resolves.toBe(false);
      await expect(
        sessions.rotate(
          { authId: other, tokenId: login.tokenId, tokenHash: login.tokenHash },
          session(other),
        ),
      ).resolves.toBe(false);
      await expect(
        sessions.rotate(
          { authId, tokenId: expired.tokenId, tokenHash: expired.tokenHash },
          session(authId),
          new Date(Date.now() + 2_000),
        ),
      ).resolves.toBe(false);
      expect(await activeSessions(authId)).toHaveLength(2);
    });

    it('revokes one session on logout and every session on demand', async () => {
      const authId = await createUser();
      const [a, b, c] = [session(authId), session(authId), session(authId)];
      for (const login of [a, b, c]) await sessions.createForLogin(login, 5);

      await sessions.revoke(authId, a.tokenId, 'LOGOUT');
      // Another user cannot revoke it.
      await sessions.revoke(await createUser(), b.tokenId, 'LOGOUT');
      expect((await activeSessions(authId)).map((s) => s.tokenId)).toEqual([
        b.tokenId,
        c.tokenId,
      ]);

      await expect(sessions.revokeAll(authId, 'LOGOUT_ALL')).resolves.toBe(2);
      expect(await activeSessions(authId)).toEqual([]);
      const reasons = await client.refreshSession.findMany({
        where: { authId },
        select: { revokedReason: true },
      });
      expect(reasons.map((row) => row.revokedReason).sort()).toEqual([
        'LOGOUT',
        'LOGOUT_ALL',
        'LOGOUT_ALL',
      ]);
    });

    it('keeps the newest five devices, revoking the oldest ones', async () => {
      const authId = await createUser();
      const logins = Array.from({ length: 7 }, () => session(authId));
      for (const login of logins) await sessions.createForLogin(login, 5);

      const active = await activeSessions(authId);
      expect(active.map((s) => s.tokenId)).toEqual(
        logins.slice(2).map((login) => login.tokenId),
      );
      const revoked = await client.refreshSession.findMany({
        where: { authId, revokedReason: 'DEVICE_LIMIT' },
      });
      expect(revoked.map((s) => s.tokenId).sort()).toEqual(
        logins
          .slice(0, 2)
          .map((login) => login.tokenId)
          .sort(),
      );
    });

    it('enforces the device limit under concurrent logins (per-user lock)', async () => {
      const authId = await createUser();
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () =>
          sessions.createForLogin(session(authId), 5),
        ),
      );

      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      for (const failure of failures) {
        expect(failure.reason).toBeInstanceOf(LoginInProgressError);
      }
      const created = results.length - failures.length;
      expect(created).toBeGreaterThan(0);
      expect((await activeSessions(authId)).length).toBe(Math.min(5, created));
    });

    it('rejects a login while another login of the same user holds the lock', async () => {
      const authId = await createUser();
      const pg = await connectToSchema(schema);
      try {
        await pg.query('BEGIN');
        await pg.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('musecue:login:${authId}', 0))`,
        );
        await expect(
          sessions.createForLogin(session(authId), 5),
        ).rejects.toBeInstanceOf(LoginInProgressError);
        // Other users are not affected.
        await expect(
          sessions.createForLogin(session(await createUser()), 5),
        ).resolves.toBeUndefined();
      } finally {
        await pg.query('COMMIT');
        await pg.end();
      }
      await expect(
        sessions.createForLogin(session(authId), 5),
      ).resolves.toBeUndefined();
    });

    it('removes expired sessions and every session of a deleted account', async () => {
      const authId = await createUser();
      const expired = session(authId, {
        expiresAt: new Date(Date.now() + 1_000),
      });
      await sessions.createForLogin(expired, 5);
      await sessions.createForLogin(session(authId), 5);

      await expect(
        sessions.deleteExpired(new Date(Date.now() + 2_000)),
      ).resolves.toBeGreaterThanOrEqual(1);
      await expect(sessions.find(expired.tokenId)).resolves.toBeNull();

      await client.authUser.delete({ where: { id: authId } });
      await expect(
        client.refreshSession.count({ where: { authId } }),
      ).resolves.toBe(0);
    });
  });

  describe('one-time codes', () => {
    const inAnHour = () => ({
      expiresAt: new Date(Date.now() + HOUR),
      maxAttempts: 5,
    });

    it('stores only a purpose- and user-bound HMAC of the code', async () => {
      const [a, b] = [await createUser(), await createUser()];
      await challenges.issue(a, 'EMAIL_VERIFICATION', 'A1B2C3', inAnHour());
      await challenges.issue(a, 'ACCOUNT_DELETION', 'A1B2C3', inAnHour());
      await challenges.issue(b, 'EMAIL_VERIFICATION', 'A1B2C3', inAnHour());

      const rows = await client.authChallenge.findMany({
        where: { authId: { in: [a, b] } },
      });
      const hashes = rows.map((row) => row.codeHash);
      expect(new Set(hashes).size).toBe(3);
      for (const hash of hashes) {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(hash).not.toBe(
          createHash('sha256').update('A1B2C3').digest('hex'),
        );
      }
      expect(JSON.stringify(rows)).not.toContain('A1B2C3');
      // A code issued for one purpose never confirms another.
      await challenges.remove(a, 'ACCOUNT_DELETION');
      await expect(
        challenges.verify(a, 'ACCOUNT_DELETION', 'A1B2C3'),
      ).resolves.toBe('EXPIRED');
    });

    it('counts guesses, accepts the right code once and never again', async () => {
      const authId = await createUser();
      await challenges.issue(authId, 'ACCOUNT_DELETION', 'C0FFEE', inAnHour());

      await expect(
        challenges.verify(authId, 'ACCOUNT_DELETION', 'BADBAD'),
      ).resolves.toBe('INVALID');
      await expect(
        challenges.verify(authId, 'ACCOUNT_DELETION', 'C0FFEE'),
      ).resolves.toBe('VALID');
      await expect(
        challenges.verify(authId, 'ACCOUNT_DELETION', 'C0FFEE'),
      ).resolves.toBe('EXPIRED');

      const row = await client.authChallenge.findFirstOrThrow({
        where: { authId },
      });
      expect(row.attempts).toBe(2);
      expect(row.consumedAt).toBeInstanceOf(Date);
    });

    it('stops accepting even the right code after the attempt limit; a new code resets it', async () => {
      const authId = await createUser();
      await challenges.issue(
        authId,
        'EMAIL_VERIFICATION',
        'C0FFEE',
        inAnHour(),
      );
      for (let guess = 0; guess < 5; guess += 1) {
        await expect(
          challenges.verify(authId, 'EMAIL_VERIFICATION', 'BADBAD'),
        ).resolves.toBe('INVALID');
      }
      await expect(
        challenges.verify(authId, 'EMAIL_VERIFICATION', 'C0FFEE'),
      ).resolves.toBe('EXPIRED');

      await challenges.issue(
        authId,
        'EMAIL_VERIFICATION',
        'D00D00',
        inAnHour(),
      );
      await expect(
        challenges.verify(authId, 'EMAIL_VERIFICATION', 'C0FFEE'),
      ).resolves.toBe('INVALID');
      await expect(
        challenges.verify(authId, 'EMAIL_VERIFICATION', 'D00D00'),
      ).resolves.toBe('VALID');
    });

    it('rejects an expired code', async () => {
      const authId = await createUser();
      const expiresAt = new Date(Date.now() + 60_000);
      await challenges.issue(authId, 'ACCOUNT_DELETION', 'C0FFEE', {
        expiresAt,
        maxAttempts: 5,
      });

      await expect(
        challenges.verify(authId, 'ACCOUNT_DELETION', 'C0FFEE', {
          now: new Date(expiresAt.getTime()),
        }),
      ).resolves.toBe('EXPIRED');
      await expect(
        challenges.deleteExpired(new Date(expiresAt.getTime() + 1)),
      ).resolves.toBeGreaterThanOrEqual(1);
    });

    it('consumes a code exactly once under concurrent submissions', async () => {
      const authId = await createUser();
      await challenges.issue(authId, 'ACCOUNT_DELETION', 'C0FFEE', {
        expiresAt: new Date(Date.now() + HOUR),
        maxAttempts: 10,
      });

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          challenges.verify(authId, 'ACCOUNT_DELETION', 'C0FFEE'),
        ),
      );

      expect(results.filter((result) => result === 'VALID')).toHaveLength(1);
      expect(results.filter((result) => result !== 'VALID')).toEqual(
        Array.from({ length: 5 }, () => 'EXPIRED'),
      );
    });

    it('commits the consumption only together with the caller’s writes', async () => {
      const authId = await createUser();
      await challenges.issue(
        authId,
        'EMAIL_VERIFICATION',
        'C0FFEE',
        inAnHour(),
      );

      await expect(
        challenges.verify(authId, 'EMAIL_VERIFICATION', 'C0FFEE', {
          onValid: async (tx) => {
            await tx.authUser.update({
              where: { id: authId },
              data: { verified: true },
            });
            throw new Error('later write failed');
          },
        }),
      ).rejects.toThrow('later write failed');
      // Nothing was committed: the account is not verified, the code unused.
      await expect(
        client.authUser.findUniqueOrThrow({ where: { id: authId } }),
      ).resolves.toMatchObject({ verified: false });

      await expect(
        challenges.verify(authId, 'EMAIL_VERIFICATION', 'C0FFEE', {
          onValid: (tx) =>
            tx.authUser
              .update({ where: { id: authId }, data: { verified: true } })
              .then(() => undefined),
        }),
      ).resolves.toBe('VALID');
      await expect(
        client.authUser.findUniqueOrThrow({ where: { id: authId } }),
      ).resolves.toMatchObject({ verified: true });
    });
  });

  describe('OAuth states', () => {
    const data = {
      state: 'will-be-replaced',
      codeVerifier: 'pkce-code-verifier-0123456789',
      redirectUrl: 'https://app.example/after-login',
      ip: '203.0.113.7',
      userAgent: 'e2e',
      createdAt: new Date().toISOString(),
    };

    it('stores the state hashed and the PKCE metadata encrypted', async () => {
      const state = randomBytes(32).toString('hex');
      await oauthStates.create('google', state, { ...data, state }, 600);

      const pg = await connectToSchema(schema);
      try {
        const { rows } = await pg.query<Record<string, unknown>>(
          'SELECT * FROM "OAuthState"',
        );
        const raw = JSON.stringify(rows);
        expect(raw).not.toContain(state);
        expect(raw).not.toContain(data.codeVerifier);
        expect(raw).not.toContain('app.example');
      } finally {
        await pg.end();
      }
      await expect(oauthStates.consume('google', state)).resolves.toEqual({
        ...data,
        state,
      });
    });

    it('is single-use, even for concurrent callbacks', async () => {
      const state = randomBytes(32).toString('hex');
      await oauthStates.create('google', state, data, 600);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => oauthStates.consume('google', state)),
      );

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      await expect(oauthStates.consume('google', state)).resolves.toBeNull();
    });

    it('rejects expired states, other providers and unknown states', async () => {
      const state = randomBytes(32).toString('hex');
      const now = new Date();
      await oauthStates.create('google', state, data, 600, now);

      await expect(oauthStates.consume('github', state)).resolves.toBeNull();
      await expect(
        oauthStates.consume('google', randomUUID()),
      ).resolves.toBeNull();
      await expect(
        oauthStates.consume('google', state, new Date(now.getTime() + 600_000)),
      ).resolves.toBeNull();
      // Consuming removed it even though it had expired.
      await expect(oauthStates.consume('google', state)).resolves.toBeNull();
    });

    it('cannot be read after the secret that protects it was rotated', async () => {
      const state = randomBytes(32).toString('hex');
      await oauthStates.create('google', state, data, 600);
      const stored = await client.oAuthState.findFirstOrThrow({
        where: { expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });

      config.jwt_refresh_secret = 'rotated-refresh-secret';
      try {
        // The hash no longer matches: the state is unknown.
        await expect(oauthStates.consume('google', state)).resolves.toBeNull();
      } finally {
        config.jwt_refresh_secret = 'auth-state-e2e-refresh-secret';
      }
      await expect(
        client.oAuthState.count({ where: { id: stored.id } }),
      ).resolves.toBe(1);
      await expect(
        oauthStates.deleteExpired(new Date(Date.now() + 601_000)),
      ).resolves.toBeGreaterThanOrEqual(1);
    });
  });

  describe('migration 20261120120000_optional_redis_infrastructure', () => {
    it('signs every user out by incrementing their token version', async () => {
      const names = migrationNames();
      const target = '20261120120000_optional_redis_infrastructure';
      const before = names.slice(0, names.indexOf(target));
      const migrationSchema = await createSchema();
      const pg = await connectToSchema(migrationSchema);
      try {
        await applyMigrations(migrationSchema, before);
        await pg.query(`
          INSERT INTO "authUser" ("id", "email", "password", "username", "tokenVersion", "updatedAt")
          VALUES ('u1', 'u1@example.com', '', 'u1', 1, now()),
                 ('u2', 'u2@example.com', '', 'u2', 7, now())
        `);
        await applyMigrations(migrationSchema, [target]);
        const { rows } = await pg.query<{ id: string; tokenVersion: number }>(
          'SELECT "id", "tokenVersion" FROM "authUser" ORDER BY "id"',
        );
        expect(rows).toEqual([
          { id: 'u1', tokenVersion: 2 },
          { id: 'u2', tokenVersion: 8 },
        ]);
      } finally {
        await pg.end();
        await dropSchema(migrationSchema);
      }
    });

    it('20261121120000_infrastructure_job_owner keeps queued jobs (without an owner)', async () => {
      const names = migrationNames();
      const target = '20261121120000_infrastructure_job_owner';
      const migrationSchema = await createSchema();
      const pg = await connectToSchema(migrationSchema);
      try {
        await applyMigrations(
          migrationSchema,
          names.slice(0, names.indexOf(target)),
        );
        await pg.query(`
          INSERT INTO "InfrastructureJob" ("id", "queue", "name", "payload", "maxAttempts")
          VALUES ('j1', 'email', 'send-welcome', 'v1.encrypted', 3)
        `);
        await applyMigrations(migrationSchema, [target]);
        const { rows } = await pg.query<{ id: string; authId: string | null }>(
          'SELECT "id", "authId" FROM "InfrastructureJob"',
        );
        expect(rows).toEqual([{ id: 'j1', authId: null }]);
        const { rows: fks } = await pg.query<{ rule: string }>(`
          SELECT c.confdeltype AS rule FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = '${migrationSchema}'
            AND c.conname = 'InfrastructureJob_authId_fkey'
        `);
        // ON DELETE CASCADE
        expect(fks).toEqual([{ rule: 'c' }]);
      } finally {
        await pg.end();
        await dropSchema(migrationSchema);
      }
    });

    it('keeps the operation input of an AI run immutable', async () => {
      const authId = await createUser();
      const makeupSession = await client.makeupSession.create({
        data: { authId },
      });
      const run = await client.aiRun.create({
        data: {
          authId,
          sessionId: makeupSession.id,
          operation: 'GUIDE_QUESTION',
          promptVersion: 'v1',
          idempotencyKey: randomUUID(),
          jobInput: { question: 'How much blush?' },
        },
      });

      await expect(
        client.aiRun.update({
          where: { id: run.id },
          data: { jobInput: { question: 'Something else' } },
        }),
      ).rejects.toThrow();
      // Other columns still change as the run progresses.
      await client.aiRun.update({
        where: { id: run.id },
        data: { status: 'PROCESSING', progress: 20 },
      });
      await expect(
        client.aiRun.findUniqueOrThrow({ where: { id: run.id } }),
      ).resolves.toMatchObject({
        status: 'PROCESSING',
        jobInput: { question: 'How much blush?' },
      });
    });
  });
});
