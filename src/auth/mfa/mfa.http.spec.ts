import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { freezeTime } from '../../../test/support/freeze-time';
import { InMemoryMfaEnrollments } from '../../../test/support/in-memory-mfa-enrollments';
import config from '../../common/config/app.config';
import { AllExceptionsFilter } from '../../common/filters/all-exception.filter';
import { AuthGuard } from '../../common/guards/auth.guard';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { PrismaService } from '../../common/services/prisma.service';
import {
  NoopTokenVersionCache,
  TokenVersionCache,
} from '../../infrastructure/token-version/token-version.cache';
import { UserRole } from '../interfaces/auth.interface';
import { AuthUtilsService } from '../services/auth-utils.service';
import type { RateLimitStore } from '../../infrastructure/rate-limit/rate-limit.store';
import { MfaCredentialsRepository } from './mfa-credentials.repository';
import { MfaEnrollmentRepository } from './mfa-enrollment.repository';
import { MfaRecoveryCodeHasher } from './mfa-recovery-code.hasher';
import { MfaLoginService } from './mfa-login.service';
import { MfaVerificationService } from './mfa-verification.service';
import { MfaSecretCipher } from './mfa-secret.cipher';
import { MfaController } from './mfa.controller';
import type {
  MfaActivationView,
  MfaEnrollmentView,
  MfaRecoveryCodesView,
  MfaStatusView,
  MfaVerificationView,
} from './mfa.interface';
import { MfaService } from './mfa.service';
import { totpCode, totpTimeStep } from './totp';

const MFA_KEY = 'mfa-http-spec-dedicated-key-0123456789abcdef';

const dataOf = <T>(response: { body: unknown }) =>
  (response.body as { data: T }).data;
const messageOf = (response: { body: unknown }) =>
  (response.body as { message: string }).message;

describe('MFA enrollment routes (mfa, HTTP)', () => {
  let app: INestApplication<App>;
  const store = new InMemoryMfaEnrollments();
  const activityLog = mock<ActivityLogService>();
  const originalAccess = config.jwt_access_secret;
  const originalRefresh = config.jwt_refresh_secret;
  const tokens = new AuthUtilsService(mock<RateLimitStore>());

  const tokenFor = (authId: string) =>
    tokens.createAccessToken({
      userId: authId,
      role: UserRole.USER,
      tokenVersion: 1,
    });
  const http = () => request(app.getHttpServer());
  const as = (authId: string) => `Bearer ${tokenFor(authId)}`;
  const currentCode = (secret: string) =>
    totpCode(secret, totpTimeStep(Date.now()));

  beforeAll(async () => {
    // One second into a 30-second TOTP step, frozen: the codes computed here
    // are the ones the server expects (no step boundary between them).
    freezeTime(new Date(Math.ceil(Date.now() / 30_000) * 30_000 + 1_000));
    config.jwt_access_secret = 'mfa-http-spec-access-secret-0123456789';
    config.jwt_refresh_secret = 'mfa-http-spec-refresh-secret-0123456789';
    // AuthGuard reads the user's token version and status.
    const prisma = {
      authUser: {
        findUnique: ({ where }: { where: { id: string } }) =>
          Promise.resolve(
            store.users.has(where.id)
              ? {
                  tokenVersion: 1,
                  status: store.get(where.id).account.status,
                }
              : null,
          ),
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [MfaController],
      providers: [
        MfaService,
        MfaVerificationService,
        { provide: MfaLoginService, useValue: mock<MfaLoginService>() },
        AuthGuard,
        { provide: MfaEnrollmentRepository, useValue: store.asRepository() },
        {
          provide: MfaCredentialsRepository,
          useValue: store.asCredentialsRepository(),
        },
        {
          provide: MfaRecoveryCodeHasher,
          useValue: new MfaRecoveryCodeHasher(
            new ConfigService({ MFA_ENCRYPTION_KEY: MFA_KEY }),
          ),
        },
        {
          provide: MfaSecretCipher,
          useValue: new MfaSecretCipher(
            new ConfigService({ MFA_ENCRYPTION_KEY: MFA_KEY }),
          ),
        },
        { provide: ActivityLogService, useValue: activityLog },
        { provide: PrismaService, useValue: prisma },
        { provide: TokenVersionCache, useClass: NoopTokenVersionCache },
        { provide: WINSTON_MODULE_PROVIDER, useValue: mock<Logger>() },
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
    await app.init();
  });

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();
    config.jwt_access_secret = originalAccess;
    config.jwt_refresh_secret = originalRefresh;
  });

  it('requires a valid access token on every route', async () => {
    await http().get('/v1/auth/mfa').expect(401);
    await http().post('/v1/auth/mfa/enrollment').expect(401);
    await http()
      .post('/v1/auth/mfa/enrollment/confirm')
      .send({ code: '123456' })
      .expect(401);
    await http()
      .get('/v1/auth/mfa')
      .set('Authorization', 'Bearer not-a-token')
      .expect(401);
  });

  it('enrolls the signed-in user end to end and reports MFA as enabled', async () => {
    const user = store.addUser({ email: 'http-owner@example.com' });
    const auth = as(user.account.authId);

    const before = await http()
      .get('/v1/auth/mfa')
      .set('Authorization', auth)
      .expect(200);
    expect(before.headers['cache-control']).toBe('no-store');
    expect(dataOf<MfaStatusView>(before)).toMatchObject({
      enabled: false,
      enrollment: { status: 'NONE', remainingAttempts: 5 },
    });

    const started = await http()
      .post('/v1/auth/mfa/enrollment')
      .set('Authorization', auth)
      .expect(201);
    expect(started.headers['cache-control']).toBe('no-store');
    expect(started.headers.pragma).toBe('no-cache');
    expect(started.body).toMatchObject({ statusCode: 201, message: 'Success' });
    const enrollment = dataOf<MfaEnrollmentView>(started);
    expect(enrollment).toMatchObject({
      method: 'totp',
      accountName: 'http-owner@example.com',
      digits: 6,
      period: 30,
    });

    const confirmed = await http()
      .post('/v1/auth/mfa/enrollment/confirm')
      .set('Authorization', auth)
      .send({ code: currentCode(enrollment.secret) })
      .expect(200);
    expect(dataOf<MfaStatusView>(confirmed)).toMatchObject({
      enabled: true,
      method: 'totp',
      enrollment: null,
    });
    const after = await http()
      .get('/v1/auth/mfa')
      .set('Authorization', auth)
      .expect(200);
    expect(dataOf<MfaStatusView>(after).enabled).toBe(true);
    // The secret is never returned again.
    expect(JSON.stringify(after.body)).not.toContain(enrollment.secret);
  });

  it.each([
    [{}],
    [{ code: '12345' }],
    [{ code: '1234567' }],
    [{ code: 'abcdef' }],
    [{ code: 123456 }],
    [{ code: '123 456' }],
  ])(
    'rejects the malformed confirmation %j with 400, without counting it',
    async (body) => {
      const user = store.addUser();
      const auth = as(user.account.authId);
      await http()
        .post('/v1/auth/mfa/enrollment')
        .set('Authorization', auth)
        .expect(201);

      await http()
        .post('/v1/auth/mfa/enrollment/confirm')
        .set('Authorization', auth)
        .send(body)
        .expect(400);

      const status = await http()
        .get('/v1/auth/mfa')
        .set('Authorization', auth)
        .expect(200);
      expect(dataOf<MfaStatusView>(status).enrollment?.remainingAttempts).toBe(
        5,
      );
    },
  );

  it('never lets a request name another account', async () => {
    const owner = store.addUser();
    const attacker = store.addUser();
    const started = await http()
      .post('/v1/auth/mfa/enrollment')
      .set('Authorization', as(owner.account.authId))
      .expect(201);
    const { secret } = dataOf<MfaEnrollmentView>(started);

    // Extra fields naming the owner are rejected outright.
    const withUserId = await http()
      .post('/v1/auth/mfa/enrollment/confirm')
      .set('Authorization', as(attacker.account.authId))
      .send({ code: currentCode(secret), userId: owner.account.authId })
      .expect(400);
    expect(messageOf(withUserId)).toContain('userId should not exist');
    await http()
      .post('/v1/auth/mfa/enrollment')
      .set('Authorization', as(attacker.account.authId))
      .send({ userId: owner.account.authId })
      .expect(400);
    await http()
      .get(`/v1/auth/mfa?userId=${owner.account.authId}`)
      .set('Authorization', as(attacker.account.authId))
      .expect(200)
      .expect((response) => {
        expect(dataOf<MfaStatusView>(response).enrollment?.status).toBe('NONE');
      });

    // The owner's valid code confirms nothing for the attacker.
    await http()
      .post('/v1/auth/mfa/enrollment/confirm')
      .set('Authorization', as(attacker.account.authId))
      .send({ code: currentCode(secret) })
      .expect(404);
    expect(store.get(owner.account.authId).account.mfaEnabled).toBe(false);
    expect(store.get(attacker.account.authId).account.mfaEnabled).toBe(false);
  });

  it('maps the refusals to their HTTP statuses', async () => {
    const user = store.addUser();
    const auth = as(user.account.authId);
    const confirm = (code: string) =>
      http()
        .post('/v1/auth/mfa/enrollment/confirm')
        .set('Authorization', auth)
        .send({ code });

    expect(messageOf(await confirm('123456').expect(404))).toBe(
      'No MFA enrollment in progress. Start a new enrollment.',
    );
    const { secret } = dataOf<MfaEnrollmentView>(
      await http()
        .post('/v1/auth/mfa/enrollment')
        .set('Authorization', auth)
        .expect(201),
    );
    const wrong = currentCode(secret) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i += 1) {
      expect(messageOf(await confirm(wrong).expect(400))).toBe(
        'Invalid or expired authentication code',
      );
    }
    expect(messageOf(await confirm(wrong).expect(429))).toMatch(
      /^Too many incorrect authentication codes/,
    );
    await confirm(currentCode(secret)).expect(429);
    await http()
      .post('/v1/auth/mfa/enrollment')
      .set('Authorization', auth)
      .expect(429);
  });

  it('refuses users whose account is no longer active', async () => {
    const user = store.addUser({ status: 'SUSPENDED' });
    await http()
      .get('/v1/auth/mfa')
      .set('Authorization', as(user.account.authId))
      .expect(401);
  });

  describe('recovery codes', () => {
    const CODE_PATTERN = /[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/;

    /** A user with MFA enabled over HTTP; the codes from the confirmation. */
    async function enabled() {
      const user = store.addUser();
      const auth = as(user.account.authId);
      const { secret } = dataOf<MfaEnrollmentView>(
        await http()
          .post('/v1/auth/mfa/enrollment')
          .set('Authorization', auth)
          .expect(201),
      );
      const confirmed = await http()
        .post('/v1/auth/mfa/enrollment/confirm')
        .set('Authorization', auth)
        .send({ code: currentCode(secret) })
        .expect(200);
      return {
        user,
        auth,
        secret,
        codes: dataOf<MfaActivationView>(confirmed).recoveryCodes,
      };
    }
    const verify = (auth: string, body: object) =>
      http().post('/v1/auth/mfa/verify').set('Authorization', auth).send(body);
    const regenerate = (auth: string, body: object) =>
      http()
        .post('/v1/auth/mfa/recovery-codes')
        .set('Authorization', auth)
        .send(body);

    it('returns the codes in the confirmation only, never in a later response', async () => {
      const { auth, codes } = await enabled();
      expect(codes).toHaveLength(10);

      const status = await http()
        .get('/v1/auth/mfa')
        .set('Authorization', auth)
        .expect(200);
      expect(dataOf<MfaStatusView>(status).recovery?.remainingCodes).toBe(10);
      expect(JSON.stringify(status.body)).not.toMatch(CODE_PATTERN);

      const verified = await verify(auth, { recoveryCode: codes[0] }).expect(
        200,
      );
      expect(verified.headers['cache-control']).toBe('no-store');
      expect(dataOf<MfaVerificationView>(verified)).toEqual({
        verified: true,
        method: 'recovery_code',
        remainingRecoveryCodes: 9,
      });
      expect(JSON.stringify(verified.body)).not.toMatch(CODE_PATTERN);

      // Refusals never echo the code either.
      const reused = await verify(auth, { recoveryCode: codes[0] }).expect(400);
      expect(JSON.stringify(reused.body)).not.toContain(codes[0]);
      expect(messageOf(reused)).toBe('Invalid or expired authentication code');
    });

    it('regenerates with a second factor, returning the new codes once', async () => {
      const { auth, codes } = await enabled();
      const response = await regenerate(auth, {
        recoveryCode: codes[0],
      }).expect(201);
      expect(response.headers['cache-control']).toBe('no-store');
      const fresh = dataOf<MfaRecoveryCodesView>(response);
      expect(fresh).toMatchObject({
        remainingRecoveryCodes: 10,
        verifiedWith: 'recovery_code',
      });
      expect(fresh.recoveryCodes).toHaveLength(10);
      await verify(auth, { recoveryCode: codes[1] }).expect(400);
      await verify(auth, { recoveryCode: fresh.recoveryCodes[1] }).expect(200);
      // Regeneration always needs a factor.
      await regenerate(auth, {}).expect(400);
    });

    it.each([
      [{}, 'send exactly one of code or recoveryCode'],
      [
        { code: '123456', recoveryCode: 'ABCD-2345-WXYZ' },
        'send exactly one of code or recoveryCode',
      ],
      [
        { recoveryCode: 'ABCD-2345' },
        'recoveryCode must look like XXXX-XXXX-XXXX',
      ],
      [{ recoveryCode: 12 }, 'recoveryCode must be a string'],
      [{ code: '12345' }, 'code must be a 6-digit authenticator code'],
    ])(
      'rejects the malformed factor %j with 400, without counting it',
      async (body, expected) => {
        const { user, auth } = await enabled();
        const response = await verify(auth, body).expect(400);
        expect(messageOf(response)).toContain(expected);
        expect(store.get(user.account.authId).counter.failedAttempts).toBe(0);
      },
    );

    it("never lets a request use or regenerate another account's codes", async () => {
      const owner = await enabled();
      const intruder = await enabled();

      await verify(intruder.auth, { recoveryCode: owner.codes[0] }).expect(400);
      const named = await verify(intruder.auth, {
        recoveryCode: owner.codes[0],
        userId: owner.user.account.authId,
      }).expect(400);
      expect(messageOf(named)).toContain('userId should not exist');
      await regenerate(intruder.auth, {
        recoveryCode: owner.codes[0],
      }).expect(400);
      expect(
        store
          .get(owner.user.account.authId)
          .recoveryCodes.every(
            (c) => c.usedAt === null && c.invalidatedAt === null,
          ),
      ).toBe(true);

      await http()
        .post('/v1/auth/mfa/verify')
        .send({ recoveryCode: owner.codes[0] })
        .expect(401);
      await http()
        .post('/v1/auth/mfa/recovery-codes')
        .send({ recoveryCode: owner.codes[0] })
        .expect(401);
    });
  });
});
