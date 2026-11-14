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

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const T0 = new Date('2026-09-01T12:00:00.000Z');
const PREFIX = config.redis_cache_key_prefix;

const store = new AccountStore();
const redis = new FakeRedis();
const emailQueue = mock<EmailQueueService>();

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
    redis.failing.clear();
    redis.clear();
    store.reset();
  });

  afterEach(() => jest.useRealTimers());

  describe('valid requests', () => {
    it('accepts the owner’s password-confirmed request, blocks the account at once and records the request', async () => {
      const user = localUser();
      const token = tokenFor(user);
      await protectedCall(token).expect(200);

      const response = await requestDeletion(token, {
        password: PASSWORD,
      }).expect(202);

      expect(viewOf(response)).toEqual({
        id: expect.any(String) as unknown,
        status: 'PENDING',
        requestedAt: T0.toISOString(),
        accountBlockedAt: T0.toISOString(),
        sessionsRevoked: true,
        message: expect.stringContaining('permanent deletion') as unknown,
      });
      expect(store.users.get(user.id)).toMatchObject({
        status: 'PENDING_DELETION',
        tokenVersion: 2,
      });
      expect(store.requests).toEqual([
        expect.objectContaining({
          id: viewOf(response).id,
          authId: user.id,
          status: 'PENDING',
          verificationMethod: 'PASSWORD',
          accountBlockedAt: T0,
          sessionsRevokedAt: T0,
          attempts: 0,
          lastError: null,
        }),
      ]);

      // Blocked immediately: the same token no longer works anywhere, and
      // every refresh token (all devices) is gone.
      await protectedCall(token).expect(401);
      expect(refreshTokensOf(user)).toEqual([]);
      expect(redis.raw(`${PREFIX}:token_version:${user.id}`)).toBe(2);
    });

    it('accepts an email-code-confirmed request from an account without a password (Google sign-in)', async () => {
      const user = googleUser();
      const token = tokenFor(user);

      const code = await requestCode(token).expect(202);
      expect(JSON.stringify(code.body)).not.toContain(emailedCode());
      expect(emailQueue.sendAccountDeletionCode.mock.calls[0]).toEqual([
        user.email,
        user.username,
        expect.stringMatching(/^[0-9A-F]{6}$/),
        10,
      ]);

      const response = await requestDeletion(token, {
        code: emailedCode(),
      }).expect(202);

      expect(viewOf(response)).toMatchObject({
        status: 'PENDING',
        sessionsRevoked: true,
      });
      expect(store.requests[store.requests.length - 1]).toMatchObject({
        authId: user.id,
        verificationMethod: 'EMAIL_CODE',
      });
      expect(store.users.get(user.id)?.status).toBe('PENDING_DELETION');
      await protectedCall(token).expect(401);
    });

    it('accepts the code case-insensitively', async () => {
      const user = googleUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);

      await requestDeletion(token, {
        code: emailedCode().toLowerCase(),
      }).expect(202);
    });

    it('only ever deletes the token owner’s account, never another one', async () => {
      const owner = localUser();
      const bystander = localUser();

      await requestDeletion(tokenFor(owner), { password: PASSWORD }).expect(
        202,
      );

      expect(store.users.get(bystander.id)).toMatchObject({
        status: 'ACTIVE',
        tokenVersion: 1,
      });
      expect(refreshTokensOf(bystander)).toHaveLength(2);
      await protectedCall(tokenFor(bystander)).expect(200);
      expect(
        store.requests.filter((item) => item.authId === bystander.id),
      ).toEqual([]);
    });
  });

  describe('wrong identity verification', () => {
    it('rejects a wrong password without blocking or recording anything, and counts it toward the lockout', async () => {
      const user = localUser();
      const token = tokenFor(user);

      const response = await requestDeletion(token, {
        password: 'wrong',
      }).expect(403);

      expect(messageOf(response)).toBe('Identity verification failed');
      expect(store.users.get(user.id)).toMatchObject({
        status: 'ACTIVE',
        tokenVersion: 1,
      });
      expect(store.users.get(user.id)?.security?.failedAttempts).toBe(1);
      expect(store.loginHistory.at(-1)).toMatchObject({
        authId: user.id,
        success: false,
      });
      expect(store.requests.filter((item) => item.authId === user.id)).toEqual(
        [],
      );
      await protectedCall(token).expect(200);
    });

    it('locks the account and signs the session out after repeated wrong passwords', async () => {
      const user = localUser();
      const token = tokenFor(user);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await requestDeletion(token, { password: 'wrong' }).expect(403);
      }

      // Five failures lock the account (same rule as login), which also
      // revokes the (possibly stolen) session.
      expect(store.users.get(user.id)?.security?.lockExpiresAt).toBeInstanceOf(
        Date,
      );
      await protectedCall(token).expect(401);
      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
      expect(store.requests.filter((item) => item.authId === user.id)).toEqual(
        [],
      );
    });

    it('refuses even the right password while the account is locked', async () => {
      const user = localUser({
        security: {
          failedAttempts: 5,
          lastFailedAt: T0,
          lockExpiresAt: new Date(T0.getTime() + 60_000),
        },
      });

      const response = await requestDeletion(tokenFor(user), {
        password: PASSWORD,
      }).expect(403);

      expect(messageOf(response)).toMatch(/temporarily locked/);
      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
    });

    it.each([
      ['no confirmation', {}],
      ['a code instead of the password', { code: 'ABC123' }],
      ['both a password and a code', { password: PASSWORD, code: 'ABC123' }],
    ])('rejects %s for an account with a password', async (_label, body) => {
      const user = localUser();

      await requestDeletion(tokenFor(user), body).expect(400);

      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
    });

    it('rejects a password for an account without one, and does not issue codes to accounts with one', async () => {
      const google = googleUser();
      const local = localUser();

      await requestDeletion(tokenFor(google), { password: '' }).expect(400);
      await requestDeletion(tokenFor(google), { password: 'anything' }).expect(
        400,
      );
      await requestCode(tokenFor(local)).expect(400);

      expect(store.users.get(google.id)?.status).toBe('ACTIVE');
      expect(emailQueue.sendAccountDeletionCode.mock.calls).toHaveLength(0);
    });

    it('rejects a wrong code, and invalidates the code after 5 wrong guesses', async () => {
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
      // Even the right code no longer works.
      await requestDeletion(token, { code }).expect(403);

      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
    });

    it('rejects an expired code (time-controlled)', async () => {
      const user = googleUser();
      const token = tokenFor(user);
      await requestCode(token).expect(202);

      jest.setSystemTime(T0.getTime() + 10 * 60_000);

      await requestDeletion(tokenFor(user), { code: emailedCode() }).expect(
        403,
      );
      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
    });

    it('does not accept another user’s code', async () => {
      const victim = googleUser();
      const attacker = googleUser();
      await requestCode(tokenFor(attacker)).expect(202);
      const attackerCode = emailedCode();

      await requestDeletion(tokenFor(victim), { code: attackerCode }).expect(
        403,
      );

      expect(store.users.get(victim.id)?.status).toBe('ACTIVE');
    });

    it('rate-limits confirmation attempts', async () => {
      const user = localUser();
      const token = tokenFor(user);
      redis.put(
        `${PREFIX}:rate_limit:account_deletion:user:${user.id}`,
        5,
        900,
      );

      await requestDeletion(token, { password: PASSWORD }).expect(429);
      expect(store.users.get(user.id)?.status).toBe('ACTIVE');
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
        const body = JSON.parse(
          JSON.stringify({ password: PASSWORD, ...extra }).replace(
            'VICTIM',
            victim.id,
          ),
        ) as object;

        await requestDeletion(tokenFor(attacker), body).expect(400);

        expect(store.users.get(victim.id)?.status).toBe('ACTIVE');
        expect(store.users.get(attacker.id)?.status).toBe('ACTIVE');
      },
    );

    it('does not let a user confirm another account with their own password', async () => {
      const attacker = localUser();
      // The victim has a different password; the attacker's token names
      // only the attacker, so the victim can never be affected.
      const victim = localUser({
        password: bcrypt.hashSync('victim-password', 4),
      });

      await requestDeletion(tokenFor(attacker), {
        password: 'victim-password',
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
      const user = localUser();
      const token = tokenFor(user);
      // Hold every transaction until all five requests have passed
      // authentication and identity verification.
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      store.beforeTransaction = async () => {
        arrived += 1;
        if (arrived === 5) release();
        await gate;
      };

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          requestDeletion(token, { password: PASSWORD }),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual(
        Array(5).fill(202),
      );
      expect(
        new Set(responses.map((response) => viewOf(response).id)).size,
      ).toBe(1);
      expect(
        store.requests.filter((item) => item.authId === user.id),
      ).toHaveLength(1);
      // Blocked once: the token version moved by exactly one.
      expect(store.users.get(user.id)?.tokenVersion).toBe(2);
    });

    it('rejects a repeated request after acceptance (the session is revoked) without a second deletion', async () => {
      const user = localUser();
      const token = tokenFor(user);
      await requestDeletion(token, { password: PASSWORD }).expect(202);

      await requestDeletion(token, { password: PASSWORD }).expect(401);
      // No new session can be obtained either: login is refused.
      await expect(
        app
          .get(AuthService)
          .login(
            { email: user.email, password: PASSWORD },
            { ip: '203.0.113.1', userAgent: 'spec' },
          ),
      ).rejects.toMatchObject({ status: 401 });

      expect(
        store.requests.filter((item) => item.authId === user.id),
      ).toHaveLength(1);
      expect(store.users.get(user.id)?.tokenVersion).toBe(2);
    });

    it('returns the same deletion when a request still gets through (stale session cache)', async () => {
      const user = localUser();
      const token = tokenFor(user);
      const first = await requestDeletion(token, { password: PASSWORD }).expect(
        202,
      );
      // Simulate a cache that still has the old version.
      redis.put(`${PREFIX}:token_version:${user.id}`, 1, 3600);

      const again = await requestDeletion(token, { password: PASSWORD }).expect(
        202,
      );

      expect(viewOf(again).id).toBe(viewOf(first).id);
      expect(
        store.requests.filter((item) => item.authId === user.id),
      ).toHaveLength(1);
      expect(store.users.get(user.id)?.tokenVersion).toBe(2);
    });
  });

  describe('processing status and resumption', () => {
    it('keeps the account blocked and records a pending revocation when Redis fails, then resumes it', async () => {
      const user = localUser();
      const token = tokenFor(user);
      redis.failing.add('eval');

      const response = await requestDeletion(token, {
        password: PASSWORD,
      }).expect(202);

      expect(viewOf(response).sessionsRevoked).toBe(false);
      const [recorded] = store.requests.filter(
        (item) => item.authId === user.id,
      );
      expect(recorded).toMatchObject({
        sessionsRevokedAt: null,
        attempts: 1,
        lastError: 'Session revocation failed; it will be retried',
      });
      expect(store.users.get(user.id)?.status).toBe('PENDING_DELETION');
      expect(refreshTokensOf(user)).toHaveLength(2);

      // Redis recovers; the recovery sweep resumes the revocation.
      redis.failing.clear();
      await expect(recovery.resume()).resolves.toBe(1);

      expect(
        store.requests.find((item) => item.id === recorded.id),
      ).toMatchObject({
        sessionsRevokedAt: T0,
        lastError: null,
      });
      expect(refreshTokensOf(user)).toEqual([]);
      await protectedCall(token).expect(401);
      // Nothing left to resume.
      await expect(recovery.resume()).resolves.toBe(0);
    });

    it('never grants access on a cache-miss: a blocked account is rejected from the database', async () => {
      const user = localUser();
      const token = tokenFor(user);
      redis.failing.add('set');
      const response = await requestDeletion(token, {
        password: PASSWORD,
      }).expect(202);
      // The cache could not be updated, so revocation is recorded as pending.
      expect(viewOf(response).sessionsRevoked).toBe(false);
      redis.failing.clear();
      // The cached version expired meanwhile.
      jest.setSystemTime(T0.getTime() + 3_600_000);

      await protectedCall(token).expect(401);
    });

    it('rolls back the block if recording the request fails', async () => {
      const user = localUser();
      const token = tokenFor(user);
      store.failNextRequestInsert = true;

      await requestDeletion(token, { password: PASSWORD }).expect(500);

      expect(store.users.get(user.id)).toMatchObject({
        status: 'ACTIVE',
        tokenVersion: 1,
      });
      expect(store.requests.filter((item) => item.authId === user.id)).toEqual(
        [],
      );
      await protectedCall(token).expect(200);
    });

    it('does not revoke sessions of an account that is not pending deletion', async () => {
      const user = localUser();
      store.requests.push({
        id: randomUUID(),
        authId: user.id,
        status: 'PENDING',
        verificationMethod: 'PASSWORD',
        requestedAt: T0,
        accountBlockedAt: T0,
        sessionsRevokedAt: null,
        processingStartedAt: null,
        completedAt: null,
        attempts: 0,
        lastError: null,
        updatedAt: T0,
      });

      await expect(recovery.resume()).resolves.toBe(0);

      expect(refreshTokensOf(user)).toHaveLength(2);
    });

    it('re-blocks a reactivated account on a new request, reusing its open request', async () => {
      const user = localUser();
      const first = await requestDeletion(tokenFor(user), {
        password: PASSWORD,
      }).expect(202);
      // An administrator reactivated the account; its request is still open.
      store.users.get(user.id)!.status = 'ACTIVE';
      signIn(store.users.get(user.id)!);

      const again = await requestDeletion(tokenFor(user), {
        password: PASSWORD,
      }).expect(202);

      expect(viewOf(again).id).toBe(viewOf(first).id);
      expect(store.users.get(user.id)).toMatchObject({
        status: 'PENDING_DELETION',
        tokenVersion: 3,
      });
      expect(
        store.requests.filter((item) => item.authId === user.id),
      ).toHaveLength(1);
    });
  });
});
