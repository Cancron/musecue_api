import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { FakeMfaRepository } from '../../../test/support/fake-mfa-repository';
import { freezeTime } from '../../../test/support/freeze-time';
import config from '../../common/config/app.config';
import { AllExceptionsFilter } from '../../common/filters/all-exception.filter';
import { AuthGuard } from '../../common/guards/auth.guard';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { PrismaService } from '../../common/services/prisma.service';
import { TokenVersionCache } from '../../infrastructure/token-version/token-version.cache';
import { UserRole } from '../interfaces/auth.interface';
import { AuthUtilsService } from '../services/auth-utils.service';
import { RateLimitStore } from '../../infrastructure/rate-limit/rate-limit.store';
import { MfaRepository } from './mfa.repository';
import { totpCode } from './mfa-totp';
import { MfaController } from './mfa.controller';
import type { MfaEnrollmentStartView, MfaStatusView } from './mfa.service';
import { MfaService } from './mfa.service';
import { MfaVerificationService } from './mfa-verification.service';
import { MfaLoginService } from './mfa-login.service';
import { MFA_KEYRING, MfaSecretCipher } from './mfa-secret.cipher';
import { testKeyring } from '../../../test/support/mfa-test-keys';
import { randomBytes } from 'node:crypto';
import { StepUpGuard } from '../step-up/step-up.guard';
import { stepUpSatisfied } from '../../../test/support/step-up-satisfied';

// Recovery codes use salted scrypt (deliberately slow, ~50-80 ms each), so
// tests that issue and verify many codes need more than the 5 s default
// when run alongside other suites.
jest.setTimeout(30_000);

const ALICE = 'alice-id';
const BOB = 'bob-id';
/** The start of a 30-second TOTP step. */
const T0 = new Date(Math.floor(Date.UTC(2026, 10, 22, 9) / 30_000) * 30_000);

const dataOf = <T>(response: { body: unknown }) =>
  (response.body as { data: T }).data;
const messageOf = (response: { body: unknown }) =>
  (response.body as { message: string }).message;

describe('MFA enrollment (HTTP)', () => {
  let app: INestApplication<App>;
  let repo: FakeMfaRepository;
  const versions = new Map<string, number>();
  const originalSecrets = {
    access: config.jwt_access_secret,
    refresh: config.jwt_refresh_secret,
  };
  const tokens = new AuthUtilsService(mock<RateLimitStore>());
  const tokenFor = (userId: string, tokenVersion = versions.get(userId)!) =>
    tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion });
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    config.jwt_access_secret = 'mfa-http-spec-access-secret-0123456789abcdef';
    // MFA must not depend on the JWT refresh secret: run without one.
    config.jwt_refresh_secret = '';
    const tokenVersions = mock<TokenVersionCache>();
    tokenVersions.get.mockImplementation((userId) =>
      Promise.resolve(versions.get(userId) ?? null),
    );
    repo = new FakeMfaRepository();

    const moduleRef = await Test.createTestingModule({
      controllers: [MfaController],
      providers: [
        MfaService,
        MfaVerificationService,
        MfaLoginService,
        MfaSecretCipher,
        { provide: MFA_KEYRING, useValue: testKeyring(randomBytes(32)) },
        AuthGuard,
        { provide: MfaRepository, useValue: repo.asRepository() },
        { provide: TokenVersionCache, useValue: tokenVersions },
        { provide: PrismaService, useValue: {} },
        { provide: WINSTON_MODULE_PROVIDER, useValue: mock<Logger>() },
      ],
    })
      // Step-up itself is covered by src/auth/step-up and mfa-step-up e2e.
      .overrideGuard(StepUpGuard)
      .useValue(stepUpSatisfied)
      .compile();
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

  beforeEach(() => {
    freezeTime(T0);
    repo.accounts.clear();
    repo.enrollments.clear();
    repo.audits.length = 0;
    versions.clear();
    for (const id of [ALICE, BOB]) {
      repo.addAccount(id, { email: `${id}@example.com` });
      versions.set(id, 1);
    }
  });

  afterEach(() => jest.useRealTimers());

  afterAll(async () => {
    await app.close();
    config.jwt_access_secret = originalSecrets.access;
    config.jwt_refresh_secret = originalSecrets.refresh;
  });

  const startFor = async (userId: string) =>
    dataOf<MfaEnrollmentStartView>(
      await http()
        .post('/auth/mfa/enrollment')
        .set(auth(tokenFor(userId)))
        .expect(201),
    );

  describe('authentication', () => {
    it.each([
      ['GET', '/auth/mfa'],
      ['POST', '/auth/mfa/enrollment'],
      ['POST', '/auth/mfa/enrollment/confirm'],
      ['POST', '/auth/mfa/verify'],
      ['POST', '/auth/mfa/recovery-codes'],
    ])('%s %s requires a bearer token', async (method, path) => {
      const req =
        method === 'GET' ? http().get(path) : http().post(path).send({});
      const response = await req.expect(401);
      expect(messageOf(response)).toBe('No token found');
    });

    it('rejects an invalid or revoked token', async () => {
      await http().get('/auth/mfa').set(auth('not-a-jwt')).expect(401);
      const stale = tokenFor(ALICE);
      versions.set(ALICE, 2); // e.g. logout-all
      const response = await http()
        .get('/auth/mfa')
        .set(auth(stale))
        .expect(401);
      expect(messageOf(response)).toBe(
        'Token has been revoked. Please login again.',
      );
    });
  });

  it('reports the status of the token user', async () => {
    const response = await http()
      .get('/auth/mfa')
      .set(auth(tokenFor(ALICE)))
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      statusCode: 200,
      message: 'Success',
      data: {
        enabled: false,
        method: null,
        recoveryCodesRemaining: null,
        enrollment: {
          status: 'NONE',
          expiresAt: null,
          blockedUntil: null,
          remainingAttempts: 5,
        },
      },
    });
  });

  it('starts and confirms an enrollment, then reports MFA enabled', async () => {
    const response = await http()
      .post('/auth/mfa/enrollment')
      .set(auth(tokenFor(ALICE)))
      .expect(201);
    // The secret is shown once and must not be cached anywhere.
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['pragma']).toBe('no-cache');
    const started = dataOf<MfaEnrollmentStartView>(response);
    expect(started).toMatchObject({
      secret: expect.stringMatching(/^[A-Z2-7]{32}$/) as string,
      digits: 6,
      period: 30,
      expiresAt: new Date(T0.getTime() + 10 * 60_000).toISOString(),
    });

    const confirmed = await http()
      .post('/auth/mfa/enrollment/confirm')
      .set(auth(tokenFor(ALICE)))
      .send({ code: totpCode(started.secret, T0) })
      .expect(200);
    expect(dataOf<MfaStatusView>(confirmed)).toMatchObject({
      enabled: true,
      method: 'totp',
    });

    const status = await http()
      .get('/auth/mfa')
      .set(auth(tokenFor(ALICE)))
      .expect(200);
    expect(dataOf<MfaStatusView>(status).enabled).toBe(true);
    expect(repo.audits[0].metadata).toMatchObject({ actionedBy: ALICE });
  });

  describe('owner scoping', () => {
    it('rejects a body naming a user on start', async () => {
      const response = await http()
        .post('/auth/mfa/enrollment')
        .set(auth(tokenFor(BOB)))
        .send({ userId: ALICE })
        .expect(400);
      expect(messageOf(response)).toBe('This endpoint does not accept a body');
      expect(repo.enrollments.size).toBe(0);
    });

    it('rejects a user ID in the confirmation body', async () => {
      const { secret } = await startFor(ALICE);
      const response = await http()
        .post('/auth/mfa/enrollment/confirm')
        .set(auth(tokenFor(BOB)))
        .send({ code: totpCode(secret, T0), userId: ALICE })
        .expect(400);
      expect(messageOf(response)).toBe('property userId should not exist');
      expect(repo.accounts.get(ALICE)!.mfaEnabled).toBe(false);
    });

    it("cannot confirm another user's enrollment with its code", async () => {
      const { secret } = await startFor(ALICE);

      // Bob has no enrollment: nothing to confirm.
      await http()
        .post('/auth/mfa/enrollment/confirm')
        .set(auth(tokenFor(BOB)))
        .send({ code: totpCode(secret, T0) })
        .expect(409);
      // With his own enrollment, Alice's code is simply wrong for him.
      await startFor(BOB);
      await http()
        .post('/auth/mfa/enrollment/confirm')
        .set(auth(tokenFor(BOB)))
        .send({ code: totpCode(secret, T0) })
        .expect(400);

      expect(repo.accounts.get(ALICE)!.mfaEnabled).toBe(false);
      expect(repo.accounts.get(BOB)!.mfaEnabled).toBe(false);
      expect(repo.enrollments.get(ALICE)!.failedAttemptsAt).toEqual([]);
    });
  });

  describe('code validation', () => {
    it.each([
      [{}, 'code must be exactly 6 digits'],
      [{ code: '12345' }, 'code must be exactly 6 digits'],
      [{ code: '1234567' }, 'code must be exactly 6 digits'],
      [{ code: 'abcdef' }, 'code must be exactly 6 digits'],
      [{ code: ' 123456' }, 'code must be exactly 6 digits'],
      [{ code: 123456 }, 'code must be a string'],
    ])('rejects %j without counting an attempt', async (body, message) => {
      await startFor(ALICE);

      const response = await http()
        .post('/auth/mfa/enrollment/confirm')
        .set(auth(tokenFor(ALICE)))
        .send(body)
        .expect(400);

      expect(messageOf(response)).toContain(message);
      expect(repo.enrollments.get(ALICE)!.failedAttemptsAt).toEqual([]);
    });
  });

  it('answers 429 once five incorrect codes blocked the enrollment', async () => {
    const { secret } = await startFor(ALICE);
    const wrong = String((Number(totpCode(secret, T0)) + 1) % 1e6).padStart(
      6,
      '0',
    );
    const confirm = () =>
      http()
        .post('/auth/mfa/enrollment/confirm')
        .set(auth(tokenFor(ALICE)))
        .send({ code: wrong });

    for (let i = 0; i < 4; i++) await confirm().expect(400);
    const blocked = await confirm().expect(429);

    expect(blocked.body).toMatchObject({
      success: false,
      statusCode: 429,
      message: expect.stringContaining(
        'MFA enrollment is blocked until',
      ) as string,
    });
    await http()
      .post('/auth/mfa/enrollment')
      .set(auth(tokenFor(ALICE)))
      .expect(429);
  });

  describe('recovery codes and verification', () => {
    /** Enables MFA for the user over HTTP; returns the one-time response. */
    async function enable(userId: string) {
      const { secret } = await startFor(userId);
      const response = await http()
        .post('/auth/mfa/enrollment/confirm')
        .set(auth(tokenFor(userId)))
        .send({ code: totpCode(secret, T0) })
        .expect(200);
      return { secret, response };
    }
    const verify = (userId: string, body: object) =>
      http()
        .post('/auth/mfa/verify')
        .set(auth(tokenFor(userId)))
        .send(body);

    it('shows the ten codes once, in an uncacheable response', async () => {
      const { response } = await enable(ALICE);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['pragma']).toBe('no-cache');
      const { recoveryCodes } = dataOf<{ recoveryCodes: string[] }>(response);
      expect(recoveryCodes).toHaveLength(10);

      // No later response contains them.
      const later = [
        await http()
          .get('/auth/mfa')
          .set(auth(tokenFor(ALICE))),
        await verify(ALICE, { recoveryCode: recoveryCodes[0] }),
        await verify(ALICE, { recoveryCode: recoveryCodes[0] }),
        await http()
          .post('/auth/mfa/enrollment/confirm')
          .set(auth(tokenFor(ALICE)))
          .send({ code: '123456' }),
      ];
      expect(later.map((r) => r.status)).toEqual([200, 200, 400, 409]);
      for (const r of later) {
        for (const code of recoveryCodes) {
          expect(JSON.stringify(r.body)).not.toContain(code);
        }
      }
      // Read before the verification below used one.
      expect(dataOf<MfaStatusView>(later[0]).recoveryCodesRemaining).toBe(10);
      expect(dataOf(later[1])).toEqual({
        verified: true,
        method: 'recovery_code',
        recoveryCodesRemaining: 9,
      });
    });

    it.each([
      [{}, 'Provide exactly one of code or recoveryCode'],
      [
        { code: '123456', recoveryCode: 'ABCDE-FGHJK' },
        'Provide exactly one of code or recoveryCode',
      ],
      [
        { recoveryCode: 'ABCD-EFGHJK' },
        'recoveryCode must look like ABCDE-FGHJK',
      ],
      [{ recoveryCode: 12345 }, 'recoveryCode must be a string'],
      [{ code: '12345' }, 'code must be exactly 6 digits'],
      [
        { recoveryCode: 'ABCDE-FGHJK', userId: BOB },
        'property userId should not exist',
      ],
    ])('rejects %j before checking anything', async (body, message) => {
      await enable(ALICE);

      const response = await verify(ALICE, body).expect(400);

      expect(messageOf(response)).toContain(message);
      expect(repo.accounts.get(ALICE)!.mfaFailedAttemptsAt).toEqual([]);
      expect(repo.unusedCodes(ALICE)).toHaveLength(10);
    });

    it("declines another user's recovery code", async () => {
      const alice = dataOf<{ recoveryCodes: string[] }>(
        (await enable(ALICE)).response,
      );
      await enable(BOB);

      await verify(BOB, { recoveryCode: alice.recoveryCodes[0] }).expect(400);
      await verify(ALICE, { recoveryCode: alice.recoveryCodes[0] }).expect(200);
    });

    it('regenerates codes (step-up approved), shown once; takes no body', async () => {
      await enable(ALICE);

      const response = await http()
        .post('/auth/mfa/recovery-codes')
        .set(auth(tokenFor(ALICE)))
        .expect(201);

      expect(response.headers['cache-control']).toBe('no-store');
      expect(
        dataOf<{ recoveryCodes: string[] }>(response).recoveryCodes,
      ).toHaveLength(10);
      // The proof is the step-up approval, never a code in the body.
      await http()
        .post('/auth/mfa/recovery-codes')
        .set(auth(tokenFor(ALICE)))
        .send({ code: '123456' })
        .expect(400);
    });
  });
});
