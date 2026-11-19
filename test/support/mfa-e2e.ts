import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { totpCode } from '../../src/auth/mfa/mfa-totp';
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

export interface TestUser {
  id: string;
  email: string;
  ip: string;
  accessToken: string;
}

export class MfaTestKit {
  /** The frozen application time. */
  clock: Date;
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

  /** (Re-)signs in at the current time: access tokens live 15 minutes. */
  async signIn(user: TestUser) {
    const response = await this.http()
      .post('/auth/login')
      .set('X-Forwarded-For', user.ip)
      .send({ email: user.email, password: PASSWORD })
      .expect(201);
    user.accessToken = dataOf<{ accessToken: string }>(response).accessToken;
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

  start(user: TestUser) {
    return this.http().post('/auth/mfa/enrollment').set(this.as(user));
  }

  confirm(user: TestUser, code: string) {
    return this.http()
      .post('/auth/mfa/enrollment/confirm')
      .set(this.as(user))
      .send({ code });
  }

  verify(user: TestUser, body: object) {
    return this.http().post('/auth/mfa/verify').set(this.as(user)).send(body);
  }

  regenerate(user: TestUser, body: object) {
    return this.http()
      .post('/auth/mfa/recovery-codes')
      .set(this.as(user))
      .send(body);
  }

  /**
   * Enables MFA for `user` over HTTP at the current time; returns the TOTP
   * secret and the response that showed the recovery codes.
   */
  async enableMfa(user: TestUser) {
    const started = dataOf<{ secret: string }>(
      await this.start(user).expect(201),
    );
    const response = await this.confirm(
      user,
      totpCode(started.secret, this.clock),
    ).expect(200);
    return {
      secret: started.secret,
      response,
      recoveryCodes: dataOf<{ recoveryCodes: string[] }>(response)
        .recoveryCodes,
    };
  }
}
