import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { totpCode } from '../../src/auth/mfa/mfa-totp';
import { MFA_LOGIN } from '../../src/auth/mfa/mfa.constants';
import type { TestApplication } from './infrastructure-flows';

/**
 * Shared helpers of the MFA e2e suites: temporary users signed in through
 * POST /auth/login, a frozen application clock that only moves forward
 * (timers stay real; see freeze-time.ts), and the MFA routes.
 */

export const PASSWORD = 'correct horse battery staple';
export const SECOND = 1000;
export const MIN = 60 * SECOND;

interface Envelope<T> {
  statusCode: number;
  message: string;
  data: T;
}
export const dataOf = <T>(response: { body: unknown }) =>
  (response.body as Envelope<T>).data;
export const messageOf = (response: { body: unknown }) =>
  (response.body as { message: string }).message;

/** A six-digit code that is certainly not `code`. */
export const wrongCode = (code: string) =>
  String((Number(code) + 1) % 1_000_000).padStart(6, '0');

/**
 * A request prepared asynchronously (e.g. after a step-up) that reads like
 * a supertest request: `await x` or `await x.expect(status)`. (A plain async
 * function cannot return a supertest request: awaiting it would send it.)
 */
export interface LazyRequest extends PromiseLike<request.Response> {
  expect(status: number): Promise<request.Response>;
}

function lazyRequest(make: () => Promise<{ test: request.Test }>): LazyRequest {
  // `make` wraps the request in an object, so resolving the promise does not
  // send it (a supertest request is thenable).
  const prepared = make;
  return {
    expect: (status) => prepared().then(({ test }) => test.expect(status)),
    then: (onFulfilled, onRejected) =>
      prepared()
        .then(({ test }) => test.then((response) => response))
        .then(onFulfilled, onRejected),
  };
}

export interface TestUser {
  id: string;
  email: string;
  ip: string;
  accessToken: string;
  /** Known once MFA was enabled through enableMfa(). */
  totpSecret?: string;
  /** Sent as X-MFA-Trusted-Device on sign-in when set. */
  trustedDeviceToken?: string;
}

export class MfaTestKit {
  /** The frozen application time. */
  clock: Date;
  /**
   * Approvals by session and action: like the app, the kit reuses an
   * approval while it is valid (ten minutes).
   */
  private readonly approvals = new Map<
    string,
    { token: string; expiresAt: number }
  >();
  private passwordHash?: string;
  private ipCounter = 0;

  constructor(
    private readonly ctx: TestApplication,
    private readonly ipPrefix: string,
  ) {
    this.clock = new Date();
  }

  http() {
    return request(this.ctx.app.getHttpServer());
  }

  setClock(to: Date) {
    this.clock = to;
    jest.setSystemTime(to);
  }

  advance(ms: number) {
    this.setClock(new Date(this.clock.getTime() + ms));
  }

  /** Moves to the start of a later 30-second TOTP step. */
  nextStepStart(afterMs = 0) {
    this.setClock(
      new Date(
        (Math.floor((this.clock.getTime() + afterMs) / 30_000) + 1) * 30_000,
      ),
    );
  }

  /** A verified local account (temporary row) signed in through the API. */
  async createUser(): Promise<TestUser> {
    this.passwordHash ??= await bcrypt.hash(PASSWORD, 4);
    const tag = randomBytes(5).toString('hex');
    const email = `mfa_${tag}@example.com`;
    const user = await this.ctx.client.authUser.create({
      data: {
        email,
        username: `mfa_${tag}`,
        password: this.passwordHash,
        verified: true,
        authSecurity: { create: { mfaEnabled: false } },
      },
    });
    const n = ++this.ipCounter;
    const ip = `${this.ipPrefix}.${Math.floor(n / 250)}.${(n % 250) + 1}`;
    const testUser = { id: user.id, email, ip, accessToken: '' };
    await this.signIn(testUser);
    return testUser;
  }

  /** POST /auth/login with the user's password (and trusted device). */
  login(user: TestUser) {
    const req = this.http().post('/auth/login').set('X-Forwarded-For', user.ip);
    if (user.trustedDeviceToken) {
      req.set(MFA_LOGIN.TRUSTED_DEVICE_HEADER, user.trustedDeviceToken);
    }
    return req.send({ email: user.email, password: PASSWORD });
  }

  /**
   * (Re-)signs in at the current time (access tokens live 15 minutes), like
   * the app: password, then, for a user with MFA enabled, the challenge
   * with the authenticator's code. The clock moves to the next 30-second
   * step first, so the code was never used before.
   */
  async signIn(user: TestUser) {
    const response = await this.login(user).expect(201);
    const body = dataOf<{
      mfaRequired: boolean;
      accessToken?: string;
      challengeToken?: string;
    }>(response);
    if (!body.mfaRequired) {
      user.accessToken = body.accessToken as string;
      return;
    }
    if (!user.totpSecret) {
      throw new Error('MFA challenge for a user whose secret is unknown');
    }
    this.nextStepStart();
    const completed = await this.http()
      .post('/auth/login/mfa')
      .set('X-Forwarded-For', user.ip)
      .send({
        challengeToken: body.challengeToken,
        code: totpCode(user.totpSecret, this.clock),
      })
      .expect(200);
    user.accessToken = dataOf<{ accessToken: string }>(completed).accessToken;
  }

  as(user: TestUser) {
    return {
      Authorization: `Bearer ${user.accessToken}`,
      'X-Forwarded-For': user.ip,
    };
  }

  getStatus(user: TestUser) {
    return this.http().get('/auth/mfa').set(this.as(user));
  }

  /**
   * A step-up approval of `action` for the user's session, the way the app
   * gets one: a fresh authenticator code for MFA users (the clock moves to
   * the next 30-second step), the password otherwise. `proof` overrides.
   */
  async approve(
    user: TestUser,
    action: string,
    proof?: Record<string, unknown>,
  ): Promise<string> {
    // Like the app: a password approval no longer counts once MFA is
    // enabled, so approvals are cached per session, action and method.
    const cacheKey = `${user.accessToken}|${action}|${user.totpSecret ? 'mfa' : 'password'}`;
    const cached = this.approvals.get(cacheKey);
    if (!proof && cached && cached.expiresAt - 5_000 > this.clock.getTime()) {
      return cached.token;
    }
    let body = proof;
    if (!body && user.totpSecret) {
      this.nextStepStart();
      body = { code: totpCode(user.totpSecret, this.clock) };
    }
    const response = await this.http()
      .post('/auth/step-up')
      .set(this.as(user))
      .send({ action, ...(body ?? { password: PASSWORD }) })
      .expect(201);
    const approval = dataOf<{ stepUpToken: string; expiresAt: string }>(
      response,
    );
    this.approvals.set(cacheKey, {
      token: approval.stepUpToken,
      expiresAt: new Date(approval.expiresAt).getTime(),
    });
    return approval.stepUpToken;
  }

  /** POST /auth/mfa/enrollment, with a step-up approval (MFA_ENROLLMENT). */
  start(user: TestUser, stepUpToken?: string): LazyRequest {
    return lazyRequest(async () => ({
      test: this.http()
        .post('/auth/mfa/enrollment')
        .set(this.as(user))
        .set(
          'X-Step-Up-Token',
          stepUpToken ?? (await this.approve(user, 'MFA_ENROLLMENT')),
        ),
    }));
  }

  /**
   * POST /auth/mfa/enrollment/confirm, with a step-up approval
   * (MFA_ENROLLMENT).
   */
  confirm(user: TestUser, code: string, stepUpToken?: string): LazyRequest {
    return lazyRequest(async () => ({
      test: this.http()
        .post('/auth/mfa/enrollment/confirm')
        .set(this.as(user))
        .set(
          'X-Step-Up-Token',
          stepUpToken ?? (await this.approve(user, 'MFA_ENROLLMENT')),
        )
        .send({ code }),
    }));
  }

  verify(user: TestUser, body: object) {
    return this.http().post('/auth/mfa/verify').set(this.as(user)).send(body);
  }

  /**
   * POST /auth/mfa/recovery-codes with a step-up approval
   * (MFA_RECOVERY_CODES): by default a fresh authenticator code; pass
   * `proof` (e.g. `{ recoveryCode }`) to approve otherwise.
   */
  regenerate(user: TestUser, proof?: Record<string, unknown>): LazyRequest {
    return lazyRequest(async () => ({
      test: this.http()
        .post('/auth/mfa/recovery-codes')
        .set(this.as(user))
        .set(
          'X-Step-Up-Token',
          await this.approve(user, 'MFA_RECOVERY_CODES', proof),
        ),
    }));
  }

  /**
   * Enables MFA for `user` over HTTP at the current time; returns the TOTP
   * secret and the response that showed the recovery codes.
   */
  async enableMfa(user: TestUser, stepUpToken?: string) {
    const started = dataOf<{ secret: string }>(
      await this.start(user, stepUpToken).expect(201),
    );
    const response = await this.confirm(
      user,
      totpCode(started.secret, this.clock),
      stepUpToken,
    ).expect(200);
    user.totpSecret = started.secret;
    return {
      secret: started.secret,
      response,
      recoveryCodes: dataOf<{ recoveryCodes: string[] }>(response)
        .recoveryCodes,
    };
  }
}
