import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { FakeMfaEnrollmentRepository } from '../../../test/support/fake-mfa-enrollment-repository';
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
import { MfaEnrollmentRepository } from './mfa-enrollment.repository';
import { totpCode } from './mfa-totp';
import { MfaController } from './mfa.controller';
import type { MfaEnrollmentStartView, MfaStatusView } from './mfa.service';
import { MfaService } from './mfa.service';

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
  let repo: FakeMfaEnrollmentRepository;
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
    config.jwt_refresh_secret = 'mfa-http-spec-refresh-secret-0123456789abcd';
    const tokenVersions = mock<TokenVersionCache>();
    tokenVersions.get.mockImplementation((userId) =>
      Promise.resolve(versions.get(userId) ?? null),
    );
    repo = new FakeMfaEnrollmentRepository();

    const moduleRef = await Test.createTestingModule({
      controllers: [MfaController],
      providers: [
        MfaService,
        AuthGuard,
        { provide: MfaEnrollmentRepository, useValue: repo.asRepository() },
        { provide: TokenVersionCache, useValue: tokenVersions },
        { provide: PrismaService, useValue: {} },
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
});
