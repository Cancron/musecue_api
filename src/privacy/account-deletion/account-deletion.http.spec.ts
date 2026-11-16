import {
  Controller,
  Get,
  Global,
  INestApplication,
  Module,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { mock } from 'jest-mock-extended';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import {
  AccountStore,
  FakeRedis,
  type StoredUser,
} from '../../../test/support/account-deletion-fakes';
import { freezeTime } from '../../../test/support/freeze-time';
import { AuthService } from '../../auth/auth.service';
import { UserRole } from '../../auth/interfaces/auth.interface';
import { AuthUtilsService } from '../../auth/services/auth-utils.service';
import config from '../../common/config/app.config';
import { AllExceptionsFilter } from '../../common/filters/all-exception.filter';
import { AuthGuard } from '../../common/guards/auth.guard';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { EmailQueueService } from '../../common/queues/email/email.queue';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { AccountDeletionCodeService } from './account-deletion-code.service';
import { AccountDeletionRecoveryService } from './account-deletion-recovery.service';
import { AccountDeletionController } from './account-deletion.controller';
import type { AccountDeletionView } from './account-deletion.interface';
import { AccountDeletionService } from './account-deletion.service';
import { AccountErasureService } from './account-erasure.service';

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const T0 = new Date('2026-09-01T12:00:00.000Z');
const PREFIX = config.redis_cache_key_prefix;

const store = new AccountStore();
const redis = new FakeRedis();
const emailQueue = mock<EmailQueueService>();
const erasure = mock<AccountErasureService>();

/** Any other protected endpoint of the application. */
@UseGuards(AuthGuard)
@Controller('v1/test-protected')
class ProtectedController {
  @Get()
  me(@Req() req: { user: { userId: string } }) {
    return { userId: req.user.userId };
  }
}

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: store.prisma },
    { provide: RedisService, useValue: redis.asService() },
    { provide: WINSTON_MODULE_PROVIDER, useValue: mock<Logger>() },
    { provide: CustomLoggerService, useValue: mock<CustomLoggerService>() },
  ],
  exports: [
    PrismaService,
    RedisService,
    WINSTON_MODULE_PROVIDER,
    CustomLoggerService,
  ],
})
class TestInfrastructureModule {}

const viewOf = (response: { body: unknown }) =>
  (response.body as { data: AccountDeletionView }).data;
const messageOf = (response: { body: unknown }) =>
  (response.body as { message: string }).message;

describe('Account deletion requests (HTTP)', () => {
  let app: INestApplication<App>;
  let recovery: AccountDeletionRecoveryService;
  let originalSecret: string;
  const tokens = new AuthUtilsService(mock<RedisService>());

  /** An access token as issued at login, for the user's current version. */
  const tokenFor = (user: StoredUser, tokenVersion = user.tokenVersion) =>
    tokens.createAccessToken({
      userId: user.id,
      role: UserRole.USER,
      tokenVersion,
    });
  const http = () => request(app.getHttpServer());
  const requestDeletion = (token: string | null, body: object = {}) => {
    const req = http().post('/v1/privacy/account-deletion').send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const requestCode = (token: string | null) => {
    const req = http().post('/v1/privacy/account-deletion/confirmation-code');
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const protectedCall = (token: string) =>
    http().get('/v1/test-protected').set('Authorization', `Bearer ${token}`);

  /** A signed-in local user with two devices (refresh tokens) and a cached token version. */
  function localUser(overrides: Partial<StoredUser> = {}): StoredUser {
    const user = store.addUser({ password: PASSWORD_HASH, ...overrides });
    signIn(user);
    return user;
  }
  function googleUser(): StoredUser {
    const user = store.addUser({
      provider: 'google',
      password: '',
      security: null,
    });
    signIn(user);
    return user;
  }
  function signIn(user: StoredUser) {
    const jtis = ['device-a', 'device-b'];
    for (const jti of jtis) {
      redis.put(`${PREFIX}:refresh:user:${user.id}:${jti}`, { jti });
    }
    redis.put(`${PREFIX}:sessions:user:${user.id}`, jtis);
    redis.put(`${PREFIX}:token_version:${user.id}`, user.tokenVersion, 3600);
  }
  const refreshTokensOf = (user: StoredUser) =>
    redis
      .keys()
      .filter((key) => key.startsWith(`${PREFIX}:refresh:user:${user.id}:`));
  const emailedCode = () =>
    emailQueue.sendAccountDeletionCode.mock.calls.at(-1)?.[2] as string;

  /**
   * The full confirmation a user performs: request the emailed code, then
   * send it (with the password, for accounts that have one).
   */
  async function confirmDeletion(
    expectedStatus: number,
    user: StoredUser,
    token = tokenFor(user),
    proof: { password?: string; code?: string } = {},
  ) {
    await requestCode(token).expect(202);
    const body =
      user.provider === 'local'
        ? { password: PASSWORD, code: emailedCode(), ...proof }
        : { code: emailedCode(), ...proof };
    return requestDeletion(token, body).expect(expectedStatus);
  }

  beforeAll(async () => {
    originalSecret = config.jwt_access_secret;
    config.jwt_access_secret = 'account-deletion-spec-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule],
      controllers: [AccountDeletionController, ProtectedController],
      providers: [
        AccountDeletionService,
        AccountDeletionCodeService,
        AccountDeletionRecoveryService,
        // Erasure has its own unit and database tests.
        { provide: AccountErasureService, useValue: erasure },
        AuthService,
        AuthUtilsService,
        AuthGuard,
        { provide: ActivityLogService, useValue: mock<ActivityLogService>() },
        { provide: EmailQueueService, useValue: emailQueue },
        {
          provide: ConfigService,
          useValue: new ConfigService({ NODE_ENV: 'test' }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    const logger = mock<Logger>();
    app.useGlobalFilters(new AllExceptionsFilter(logger));
    app.useGlobalInterceptors(new TransformInterceptor(logger));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    recovery = moduleRef.get(AccountDeletionRecoveryService);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    config.jwt_access_secret = originalSecret;
  });

  beforeEach(() => {
    freezeTime(T0);
    jest.clearAllMocks();
    emailQueue.sendAccountDeletionCode.mockResolvedValue();
    erasure.process.mockResolvedValue('PENDING');
    redis.failing.clear();
    redis.clear();
    store.reset();
  });

  afterEach(() => jest.useRealTimers());

  const requestsOf = (user: StoredUser) =>
    store.requests.filter((item) => item.authId === user.id);

  describe('identity verification', () => {
    it('accepts a password account confirmed with BOTH its password and the emailed code', async () => {
      const user = localUser();
      const token = tokenFor(user);

      const response = await confirmDeletion(202, user, token);

      expect(viewOf(response)).toEqual({
        id: expect.any(String) as unknown,
        status: 'PENDING',
        requestedAt: T0.toISOString(),
        accountBlockedAt: T0.toISOString(),
        sessionsRevoked: true,
        message: expect.stringContaining('permanent deletion') as unknown,
      });
      expect(requestsOf(user)).toEqual([
        expect.objectContaining({
          verificationMethod: 'PASSWORD_AND_EMAIL_CODE',
          accountBlockedAt: T0,
          sessionsRevokedAt: T0,
        }),
      ]);
      expect(store.users.get(user.id)).toMatchObject({
        status: 'PENDING_DELETION',
        tokenVersion: 2,
      });
      // The code was sent to the account's own address.
      expect(emailQueue.sendAccountDeletionCode.mock.calls[0][0]).toBe(
        user.email,
      );
    });

    it('accepts a passwordless (Google) account confirmed with the emailed code alone', async () => {
      const user = googleUser();

      await confirmDeletion(202, user);

      expect(requestsOf(user)).toEqual([
        expect.objectContaining({ verificationMethod: 'EMAIL_CODE' }),
      ]);
      expect(store.users.get(user.id)?.status).toBe('PENDING_DELETION');
    });

    it('accepts the code case-insensitively', async () => {
      const user = googleUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);

      await requestDeletion(token, {
        code: emailedCode().toLowerCase(),
      }).expect(202);
    });

    it('never returns the code to the client', async () => {
      const user = localUser();

      const response = await requestCode(tokenFor(user)).expect(202);

      expect(JSON.stringify(response.body)).not.toContain(emailedCode());
    });

    it.each([
      ['the password alone', () => ({ password: PASSWORD })],
      ['the code alone', () => ({ code: emailedCode() })],
      ['no proof', () => ({})],
    ])(
      'rejects %s for a password account (both are required)',
      async (_label, proof) => {
        const user = localUser();
        const token = tokenFor(user);
        await requestCode(token).expect(202);

        await requestDeletion(token, proof()).expect(400);

        expect(store.users.get(user.id)?.status).toBe('ACTIVE');
        expect(requestsOf(user)).toEqual([]);
      },
    );

    it('rejects a password for an account without one', async () => {
      const user = googleUser();

      await confirmDeletion(400, user, tokenFor(user), {
        password: 'anything',
      });

      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
    });

    it('rejects the right password with a wrong code (and keeps the password counter untouched)', async () => {
      const user = localUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);
      const wrong = emailedCode() === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';

      const response = await requestDeletion(token, {
        password: PASSWORD,
        code: wrong,
      }).expect(403);

      expect(messageOf(response)).toBe('Identity verification failed');
      expect(store.users.get(user.id)?.security?.failedAttempts).toBe(0);
      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
      await protectedCall(token).expect(200);
    });

    it('rejects a wrong password with the right code, counts it toward the lockout, and leaves the code usable', async () => {
      const user = localUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);
      const code = emailedCode();

      await requestDeletion(token, { password: 'wrong', code }).expect(403);

      expect(store.users.get(user.id)?.security?.failedAttempts).toBe(1);
      expect(store.loginHistory.at(-1)).toMatchObject({
        authId: user.id,
        success: false,
      });
      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
      // The code was not consumed by the failed password check.
      await requestDeletion(token, { password: PASSWORD, code }).expect(202);
    });

    it('locks the account and signs the session out after repeated wrong passwords', async () => {
      const user = localUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await requestDeletion(token, {
          password: 'wrong',
          code: emailedCode(),
        }).expect(403);
      }

      expect(store.users.get(user.id)?.security?.lockExpiresAt).toBeInstanceOf(
        Date,
      );
      await protectedCall(token).expect(401);
      expect(requestsOf(user)).toEqual([]);
    });

    it('refuses even the right proof while the account is locked', async () => {
      const user = localUser({
        security: {
          failedAttempts: 5,
          lastFailedAt: T0,
          lockExpiresAt: new Date(T0.getTime() + 60_000),
        },
      });

      const response = await confirmDeletion(403, user);

      expect(messageOf(response)).toMatch(/temporarily locked/);
      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
    });

    it('invalidates the code after 5 wrong guesses', async () => {
      const user = googleUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);
      const code = emailedCode();
      const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';

      for (let guess = 0; guess < 5; guess += 1) {
        await requestDeletion(token, { code: wrong }).expect(403);
      }
      // Isolate the code rule from the separate per-user rate limit.
      redis.remove(`${PREFIX}:rate_limit:account_deletion:user:${user.id}`);

      await requestDeletion(token, { code }).expect(403);
      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
    });

    it('rejects an expired code (time-controlled)', async () => {
      const user = localUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);

      jest.setSystemTime(T0.getTime() + 10 * 60_000);

      await requestDeletion(tokenFor(user), {
        password: PASSWORD,
        code: emailedCode(),
      }).expect(403);
      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
    });

    it('does not accept another user’s code', async () => {
      const victim = localUser();
      const attacker = localUser();
      await requestCode(tokenFor(attacker)).expect(202);

      await requestDeletion(tokenFor(victim), {
        password: PASSWORD,
        code: emailedCode(),
      }).expect(403);

      expect(store.users.get(victim.id)?.status).toBe('ACTIVE');
    });

    it('rate-limits confirmation attempts', async () => {
      const user = localUser();
      redis.put(
        `${PREFIX}:rate_limit:account_deletion:user:${user.id}`,
        5,
        900,
      );

      await confirmDeletion(429, user);
      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
    });
  });

  describe('token and session invalidation', () => {
    it('invalidates the current token and every other session the moment the deletion is approved', async () => {
      const user = localUser();
      const token = tokenFor(user);
      const otherDevice = tokenFor(user);
      await protectedCall(token).expect(200);

      await confirmDeletion(202, user, token);

      await protectedCall(token).expect(401);
      await protectedCall(otherDevice).expect(401);
      expect(refreshTokensOf(user)).toEqual([]);
      expect(redis.raw(`${PREFIX}:token_version:${user.id}`)).toBe(2);
    });

    it('does not approve the deletion when the token cache cannot be updated (nothing is committed)', async () => {
      const user = localUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);
      redis.failing.add('set');

      const response = await requestDeletion(token, {
        password: PASSWORD,
        code: emailedCode(),
      }).expect(503);

      expect(messageOf(response)).toMatch(/temporarily unavailable/);
      expect(store.users.get(user.id)).toMatchObject({
        status: 'ACTIVE',
        tokenVersion: 1,
      });
      expect(requestsOf(user)).toEqual([]);
      redis.failing.clear();
      await protectedCall(token).expect(200);
    });

    it('keeps old tokens out even when a stale read races with the approval (guard fills the cache only if empty)', async () => {
      const user = localUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);
      const code = emailedCode();
      // Cache miss: the guard will read the user from the database.
      redis.remove(`${PREFIX}:token_version:${user.id}`);
      // Pause that read after it saw the ACTIVE, version-1 row, until the
      // deletion has been approved.
      let approved!: () => void;
      const approval = new Promise<void>((resolve) => (approved = resolve));
      let paused = false;
      store.onUserLookup = async (id) => {
        if (id === user.id && !paused) {
          paused = true;
          await approval;
        }
      };

      const staleRequest = protectedCall(token).then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 20));
      store.onUserLookup = null;
      await requestDeletion(token, { password: PASSWORD, code }).expect(202);
      approved();
      await staleRequest;

      // The stale read must not have restored the old version in the cache.
      expect(redis.raw(`${PREFIX}:token_version:${user.id}`)).toBe(2);
      await protectedCall(token).expect(401);
    });

    it('rejects a blocked account from the database when the cache is empty', async () => {
      const user = localUser();
      const token = tokenFor(user);
      await confirmDeletion(202, user, token);
      redis.remove(`${PREFIX}:token_version:${user.id}`);

      await protectedCall(token).expect(401);
    });

    it('refuses new sign-ins after approval', async () => {
      const user = localUser();
      await confirmDeletion(202, user);

      await expect(
        app
          .get(AuthService)
          .login(
            { email: user.email, password: PASSWORD },
            { ip: '203.0.113.1', userAgent: 'spec' },
          ),
      ).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('unauthorized access', () => {
    it.each([
      ['deletion', () => requestDeletion(null, { password: PASSWORD })],
      ['confirmation code', () => requestCode(null)],
    ])('requires a bearer token for the %s endpoint', async (_label, call) => {
      await call().expect(401);
      expect(emailQueue.sendAccountDeletionCode.mock.calls).toHaveLength(0);
    });

    it('rejects forged and revoked tokens', async () => {
      const user = localUser();
      const forged = new AuthUtilsService(mock<RedisService>());
      config.jwt_access_secret = 'attacker-secret';
      const forgedToken = forged.createAccessToken({
        userId: user.id,
        role: UserRole.USER,
        tokenVersion: 1,
      });
      config.jwt_access_secret = 'account-deletion-spec-secret';

      await requestCode(forgedToken).expect(401);
      await requestDeletion(forgedToken, { password: PASSWORD }).expect(401);
      await requestDeletion(tokenFor(user, 0), { password: PASSWORD }).expect(
        401,
      );

      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
    });

    it.each([
      { userId: 'VICTIM' },
      { authId: 'VICTIM' },
      { accountId: 'VICTIM' },
    ])(
      'never lets a request name the account (%j is rejected)',
      async (extra) => {
        const attacker = localUser();
        const victim = localUser();

        await confirmDeletion(400, attacker, tokenFor(attacker), {
          ...(JSON.parse(
            JSON.stringify(extra).replace('VICTIM', victim.id),
          ) as object),
        });

        expect(store.users.get(victim.id)?.status).toBe('ACTIVE');
        expect(store.users.get(attacker.id)?.status).toBe('ACTIVE');
      },
    );

    it('only ever deletes the token owner’s account, even with another user’s proof', async () => {
      const attacker = localUser();
      const victim = localUser({
        password: bcrypt.hashSync('victim-password', 4),
      });
      await requestCode(tokenFor(victim)).expect(202);
      const victimCode = emailedCode();

      await requestDeletion(tokenFor(attacker), {
        password: 'victim-password',
        code: victimCode,
      }).expect(403);

      expect(store.users.get(victim.id)?.status).toBe('ACTIVE');
      expect(store.users.get(attacker.id)?.status).toBe('ACTIVE');
    });

    it('rejects a body on the confirmation-code endpoint', async () => {
      const user = googleUser();

      await requestCode(tokenFor(user))
        .send({ userId: randomUUID() })
        .expect(400);
    });
  });

  describe('multiple requests', () => {
    it('answers concurrent requests with one and the same deletion', async () => {
      const user = googleUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);
      const code = emailedCode();
      // The code is single-use: pre-verify concurrency at the transaction,
      // where all five requests meet after passing authentication.
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      store.beforeTransaction = async () => {
        arrived += 1;
        if (arrived === 2) release();
        await gate;
      };
      const verify = jest
        .spyOn(app.get(AccountDeletionCodeService), 'verify')
        .mockResolvedValue(true);

      const responses = await Promise.all([
        requestDeletion(token, { code }),
        requestDeletion(token, { code }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([202, 202]);
      expect(
        new Set(responses.map((response) => viewOf(response).id)).size,
      ).toBe(1);
      expect(requestsOf(user)).toHaveLength(1);
      expect(store.users.get(user.id)?.tokenVersion).toBe(2);
      verify.mockRestore();
    });

    it('rejects a repeated request after approval without a second deletion', async () => {
      const user = localUser();
      const token = tokenFor(user);
      await confirmDeletion(202, user, token);

      await requestDeletion(token, { password: PASSWORD }).expect(401);
      await requestCode(token).expect(401);

      expect(requestsOf(user)).toHaveLength(1);
      expect(store.users.get(user.id)?.tokenVersion).toBe(2);
    });

    it('re-blocks a reactivated account on a new request, reusing its open request', async () => {
      const user = localUser();
      const first = await confirmDeletion(202, user);
      store.users.get(user.id)!.status = 'ACTIVE';
      signIn(store.users.get(user.id)!);

      const again = await confirmDeletion(202, user);

      expect(viewOf(again).id).toBe(viewOf(first).id);
      expect(store.users.get(user.id)).toMatchObject({
        status: 'PENDING_DELETION',
        tokenVersion: 3,
      });
      expect(requestsOf(user)).toHaveLength(1);
    });
  });

  describe('processing status and resumption', () => {
    it('records a pending session cleanup when removing refresh sessions fails, and resumes it', async () => {
      const user = localUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);
      redis.failing.add('eval');

      const response = await requestDeletion(token, {
        password: PASSWORD,
        code: emailedCode(),
      }).expect(202);

      expect(viewOf(response).sessionsRevoked).toBe(false);
      const [recorded] = requestsOf(user);
      expect(recorded).toMatchObject({
        sessionsRevokedAt: null,
        attempts: 1,
        lastError: 'Session revocation failed; it will be retried',
      });
      // Access tokens are invalid already (published in the transaction).
      await protectedCall(token).expect(401);

      redis.failing.clear();
      const result = await recovery.resume();

      expect(result.sessionsRevoked).toBe(1);
      expect(requestsOf(user)[0]).toMatchObject({
        sessionsRevokedAt: T0,
        lastError: null,
      });
      expect(refreshTokensOf(user)).toEqual([]);
      // The sweep also hands the request to erasure.
      expect(erasure.process.mock.calls).toContainEqual([recorded.id, T0]);
    });

    it('rolls back the block, and the token cache, if recording the request fails', async () => {
      const user = localUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);
      store.failNextRequestInsert = true;

      await requestDeletion(token, {
        password: PASSWORD,
        code: emailedCode(),
      }).expect(500);

      expect(store.users.get(user.id)).toMatchObject({
        status: 'ACTIVE',
        tokenVersion: 1,
      });
      expect(requestsOf(user)).toEqual([]);
      await protectedCall(token).expect(200);
    });

    it('does not revoke sessions of an account that is not pending deletion', async () => {
      const user = localUser();
      store.requests.push({
        id: randomUUID(),
        authId: user.id,
        status: 'PENDING',
        verificationMethod: 'PASSWORD_AND_EMAIL_CODE',
        requestedAt: T0,
        accountBlockedAt: T0,
        sessionsRevokedAt: null,
        processingStartedAt: null,
        filesRecordedAt: null,
        dataErasedAt: null,
        filesDeletedAt: null,
        completedAt: null,
        lockedUntil: null,
        attempts: 0,
        lastError: null,
        updatedAt: T0,
      });

      const result = await recovery.resume();

      expect(result.sessionsRevoked).toBe(0);
      expect(refreshTokensOf(user)).toHaveLength(2);
    });
  });
});
