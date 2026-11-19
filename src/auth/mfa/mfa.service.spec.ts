import { HttpException } from '@nestjs/common';
import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { FakeMfaEnrollmentRepository } from '../../../test/support/fake-mfa-enrollment-repository';
import config from '../../common/config/app.config';
import { decryptMfaSecret } from './mfa-secret.cipher';
import { totpCode, totpStep } from './mfa-totp';
import { MfaService } from './mfa.service';

const USER = 'user-owner';
const OTHER = 'user-other';
const META = { ip: '203.0.113.7', userAgent: 'jest', device: 'ios' };
/** The start of a 30-second TOTP step. */
const T0 = new Date(Math.floor(Date.UTC(2026, 10, 22, 12) / 30_000) * 30_000);
const plus = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

/** A six-digit code that is certainly not `code`. */
const wrongCode = (code: string) =>
  String((Number(code) + 1) % 1_000_000).padStart(6, '0');

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), message: error.message };
  }
  throw new Error('Expected the call to be rejected');
}

describe('MfaService', () => {
  const originalSecret = config.jwt_refresh_secret;
  let repo: FakeMfaEnrollmentRepository;
  let logger: ReturnType<typeof mock<Logger>>;
  let service: MfaService;

  beforeAll(() => {
    config.jwt_refresh_secret = 'mfa-service-unit-test-refresh-secret-0123';
  });
  afterAll(() => {
    config.jwt_refresh_secret = originalSecret;
  });

  beforeEach(() => {
    repo = new FakeMfaEnrollmentRepository();
    repo.addAccount(USER, { email: 'owner@example.com' });
    repo.addAccount(OTHER);
    logger = mock<Logger>();
    service = new MfaService(repo.asRepository(), logger);
  });

  const start = (now = T0, authId = USER) =>
    service.startEnrollment(authId, now);
  const confirm = (code: string, now = T0, authId = USER) =>
    service.confirmEnrollment(authId, code, META, now);

  describe('status', () => {
    it('is disabled with no enrollment for a new account', async () => {
      await expect(service.getStatus(USER, T0)).resolves.toEqual({
        enabled: false,
        method: null,
        enrollment: {
          status: 'NONE',
          expiresAt: null,
          blockedUntil: null,
          remainingAttempts: 5,
        },
      });
    });

    it('reports a pending enrollment, then its expiry', async () => {
      await start();
      expect((await service.getStatus(USER, plus(MIN))).enrollment).toEqual({
        status: 'PENDING',
        expiresAt: plus(10 * MIN),
        blockedUntil: null,
        remainingAttempts: 5,
      });
      expect(
        (await service.getStatus(USER, plus(10 * MIN))).enrollment.status,
      ).toBe('EXPIRED');
    });

    it('reports enabled MFA', async () => {
      const { secret } = await start();
      await confirm(totpCode(secret, T0));
      await expect(service.getStatus(USER, T0)).resolves.toMatchObject({
        enabled: true,
        method: 'totp',
        enrollment: { status: 'NONE' },
      });
    });

    it('rejects a token whose user no longer exists or is not active', async () => {
      await expect(rejection(service.getStatus('gone', T0))).resolves.toEqual({
        status: 401,
        message: 'User not found',
      });
      repo.addAccount('blocked', { status: 'PENDING_DELETION' });
      await expect(
        rejection(service.getStatus('blocked', T0)),
      ).resolves.toMatchObject({ status: 403 });
    });
  });

  describe('starting an enrollment', () => {
    it('returns a new secret and otpauth URI valid for 10 minutes', async () => {
      const view = await start();

      expect(view).toEqual({
        secret: expect.stringMatching(/^[A-Z2-7]{32}$/) as string,
        otpauthUrl: expect.stringContaining('otpauth://totp/') as string,
        issuer: 'MuseCue',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        expiresAt: plus(10 * MIN),
      });
      expect(view.otpauthUrl).toContain(`secret=${view.secret}`);
      expect(decodeURIComponent(view.otpauthUrl)).toContain(
        'MuseCue:owner@example.com',
      );
    });

    it('stores the pending secret only encrypted and bound to the user', async () => {
      const { secret } = await start();
      const stored = repo.enrollments.get(USER)!;

      expect(stored.secret).not.toContain(secret);
      expect(decryptMfaSecret('enrollment', USER, stored.secret!)).toBe(secret);
      expect(stored.expiresAt).toEqual(plus(10 * MIN));
      // Nothing is enabled until the code is confirmed.
      expect(repo.accounts.get(USER)).toMatchObject({
        mfaEnabled: false,
        mfaSecret: null,
      });
    });

    it('replaces the secret and expiry on restart', async () => {
      const first = await start();
      const second = await start(plus(5 * MIN));

      expect(second.secret).not.toBe(first.secret);
      expect(second.expiresAt).toEqual(plus(15 * MIN));
      // The old secret's code no longer works.
      await expect(
        rejection(
          confirm(totpCode(first.secret, plus(5 * MIN)), plus(5 * MIN)),
        ),
      ).resolves.toMatchObject({ status: 400 });
    });

    it('is refused while MFA is enabled', async () => {
      const { secret } = await start();
      await confirm(totpCode(secret, T0));

      await expect(rejection(start(plus(MIN)))).resolves.toEqual({
        status: 409,
        message: 'MFA is already enabled for this account',
      });
    });

    it('only ever touches the caller', async () => {
      await start(T0, USER);
      expect(repo.enrollments.has(OTHER)).toBe(false);
      expect(repo.accounts.get(OTHER)!.mfaEnabled).toBe(false);
    });
  });

  describe('confirming an enrollment', () => {
    it('enables MFA with the current code and stores the secret encrypted', async () => {
      const { secret } = await start();

      const view = await confirm(totpCode(secret, plus(20_000)), plus(20_000));

      expect(view).toEqual({
        enabled: true,
        method: 'totp',
        enrollment: {
          status: 'NONE',
          expiresAt: null,
          blockedUntil: null,
          remainingAttempts: 5,
        },
      });
      const account = repo.accounts.get(USER)!;
      expect(account).toMatchObject({ mfaEnabled: true, mfaMethod: 'totp' });
      expect(account.mfaSecret).not.toContain(secret);
      expect(decryptMfaSecret('confirmed', USER, account.mfaSecret!)).toBe(
        secret,
      );
      expect(account.mfaLastUsedStep).toBe(totpStep(plus(20_000)));
      // The pending enrollment (and its copy of the secret) is gone.
      expect(repo.enrollments.has(USER)).toBe(false);
      expect(repo.audits).toEqual([
        { authId: USER, metadata: { ...META, actionedBy: USER } },
      ]);
    });

    it('accepts a code until the last millisecond of its 30-second step', async () => {
      const { secret } = await start();
      const code = totpCode(secret, T0);

      await expect(confirm(code, plus(29_999))).resolves.toMatchObject({
        enabled: true,
      });
    });

    it('rejects an expired code (its 30 seconds are over) and counts it', async () => {
      const { secret } = await start();
      const code = totpCode(secret, T0);

      await expect(rejection(confirm(code, plus(30_000)))).resolves.toEqual({
        status: 400,
        message:
          'Invalid or expired authenticator code. 4 attempt(s) remaining.',
      });
      expect(repo.accounts.get(USER)!.mfaEnabled).toBe(false);
      expect(repo.enrollments.get(USER)!.failedAttemptsAt).toEqual([
        plus(30_000),
      ]);
    });

    it('rejects an invalid code and keeps the enrollment pending', async () => {
      const { secret } = await start();

      await expect(
        rejection(confirm(wrongCode(totpCode(secret, T0)))),
      ).resolves.toMatchObject({ status: 400 });

      const status = await service.getStatus(USER, T0);
      expect(status.enabled).toBe(false);
      expect(status.enrollment).toMatchObject({
        status: 'PENDING',
        remainingAttempts: 4,
      });
      // The right code still works afterwards.
      await expect(confirm(totpCode(secret, T0))).resolves.toMatchObject({
        enabled: true,
      });
    });

    it('never accepts an already used code again', async () => {
      const { secret } = await start();
      const code = totpCode(secret, T0);
      await confirm(code);

      await expect(rejection(confirm(code, plus(1000)))).resolves.toEqual({
        status: 409,
        message: 'MFA is already enabled for this account',
      });
      expect(repo.audits).toHaveLength(1);
    });

    it('accepts one of concurrent confirmations with the same code', async () => {
      const { secret } = await start();
      const code = totpCode(secret, T0);

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => confirm(code)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const statuses = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason as HttpException).getStatus());
      expect(statuses).toEqual([409, 409, 409, 409]);
      expect(repo.audits).toHaveLength(1);
    });

    it('expires the enrollment after 10 minutes and forgets its secret', async () => {
      const { secret } = await start();
      const expiry = plus(10 * MIN);

      await expect(
        rejection(confirm(totpCode(secret, expiry), expiry)),
      ).resolves.toEqual({
        status: 410,
        message: 'The MFA enrollment has expired. Start a new enrollment.',
      });
      expect(repo.enrollments.get(USER)).toMatchObject({
        secret: null,
        expiresAt: null,
      });
      expect(repo.accounts.get(USER)!.mfaEnabled).toBe(false);
      // Afterwards there is nothing left to confirm.
      await expect(
        rejection(confirm(totpCode(secret, plus(11 * MIN)), plus(11 * MIN))),
      ).resolves.toMatchObject({ status: 409 });
    });

    it('accepts a valid code just before the enrollment expires', async () => {
      const { secret } = await start();
      const lastMoment = plus(10 * MIN - 1);

      await expect(
        confirm(totpCode(secret, lastMoment), lastMoment),
      ).resolves.toMatchObject({ enabled: true });
    });

    it('refuses a confirmation without an enrollment', async () => {
      await expect(rejection(confirm('123456'))).resolves.toEqual({
        status: 409,
        message: 'No MFA enrollment is in progress. Start a new enrollment.',
      });
      // Not an incorrect code: nothing is counted.
      expect(repo.enrollments.has(USER)).toBe(false);
    });

    it("cannot confirm with another user's enrollment code", async () => {
      const mine = await start(T0, USER);
      await start(T0, OTHER);

      await expect(
        rejection(confirm(totpCode(mine.secret, T0), T0, OTHER)),
      ).resolves.toMatchObject({ status: 400 });
      expect(repo.accounts.get(OTHER)!.mfaEnabled).toBe(false);
      expect(repo.accounts.get(USER)!.mfaEnabled).toBe(false);
      expect(repo.enrollments.get(USER)!.failedAttemptsAt).toEqual([]);
    });

    it('treats an undecryptable pending secret as expired', async () => {
      await start();
      repo.enrollments.get(USER)!.secret = 'v1.AAAA.AAAA.AAAA';

      await expect(rejection(confirm('123456'))).resolves.toMatchObject({
        status: 410,
      });
      expect(repo.enrollments.get(USER)!.secret).toBeNull();
    });
  });

  describe('lockout after incorrect codes', () => {
    /** Submits `count` incorrect codes, one minute apart from `from`. */
    async function failTimes(secret: string, count: number, from = T0) {
      const results: { status: number; message: string }[] = [];
      for (let i = 0; i < count; i++) {
        const now = new Date(from.getTime() + i * MIN);
        results.push(
          await rejection(confirm(wrongCode(totpCode(secret, now)), now)),
        );
      }
      return results;
    }

    it('blocks enrollment for 15 minutes after 5 incorrect codes in 15 minutes', async () => {
      const { secret } = await start();

      const results = await failTimes(secret, 5);

      expect(results.slice(0, 4).map((r) => r.message)).toEqual([
        'Invalid or expired authenticator code. 4 attempt(s) remaining.',
        'Invalid or expired authenticator code. 3 attempt(s) remaining.',
        'Invalid or expired authenticator code. 2 attempt(s) remaining.',
        'Invalid or expired authenticator code. 1 attempt(s) remaining.',
      ]);
      const blockedUntil = plus(4 * MIN + 15 * MIN);
      expect(results[4]).toEqual({
        status: 429,
        message: `Too many incorrect codes. MFA enrollment is blocked until ${blockedUntil.toISOString()}.`,
      });
      expect(repo.enrollments.get(USER)).toEqual({
        secret: null,
        expiresAt: null,
        failedAttemptsAt: [],
        blockedUntil,
      });
      expect((await service.getStatus(USER, plus(5 * MIN))).enrollment).toEqual(
        {
          status: 'BLOCKED',
          expiresAt: null,
          blockedUntil,
          remainingAttempts: 0,
        },
      );
    });

    it('refuses even the correct code, and a restart, while blocked', async () => {
      const { secret } = await start();
      await failTimes(secret, 5);
      const during = plus(10 * MIN);

      await expect(
        rejection(confirm(totpCode(secret, during), during)),
      ).resolves.toMatchObject({ status: 429 });
      await expect(rejection(start(during))).resolves.toMatchObject({
        status: 429,
      });
      // Attempts during the block neither count nor extend it.
      expect(repo.enrollments.get(USER)!.blockedUntil).toEqual(plus(19 * MIN));
      expect(repo.accounts.get(USER)!.mfaEnabled).toBe(false);
    });

    it('allows a new enrollment once the block is over', async () => {
      const { secret: old } = await start();
      await failTimes(old, 5);
      const after = plus(19 * MIN);

      const { secret } = await start(after);

      expect(secret).not.toBe(old);
      await expect(
        confirm(totpCode(secret, after), after),
      ).resolves.toMatchObject({ enabled: true });
    });

    it('does not reset the failure count when the enrollment is restarted', async () => {
      const first = await start();
      await failTimes(first.secret, 4);
      const { secret } = await start(plus(5 * MIN));

      await expect(
        rejection(
          confirm(wrongCode(totpCode(secret, plus(6 * MIN))), plus(6 * MIN)),
        ),
      ).resolves.toMatchObject({ status: 429 });
    });

    it('forgets failures older than 15 minutes', async () => {
      const first = await start();
      await failTimes(first.secret, 4);
      const later = plus(3 * MIN + 15 * MIN + 1);
      const { secret } = await start(later);

      await expect(
        rejection(confirm(wrongCode(totpCode(secret, later)), later)),
      ).resolves.toEqual({
        status: 400,
        message:
          'Invalid or expired authenticator code. 4 attempt(s) remaining.',
      });
    });

    it("does not block other users' enrollment", async () => {
      const { secret } = await start(T0, USER);
      await failTimes(secret, 5);

      const other = await start(plus(5 * MIN), OTHER);
      await expect(
        confirm(totpCode(other.secret, plus(5 * MIN)), plus(5 * MIN), OTHER),
      ).resolves.toMatchObject({ enabled: true });
    });
  });

  describe('failures of the database or the key', () => {
    it('answer 503 and never look like a wrong code', async () => {
      await start();
      repo.failWith = new Error('connection refused');

      await expect(rejection(confirm('123456'))).resolves.toEqual({
        status: 503,
        message: 'MFA is temporarily unavailable. Please try again.',
      });
      expect(repo.enrollments.get(USER)!.failedAttemptsAt).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        'MFA state could not be read or written',
        expect.objectContaining({ errorName: 'Error' }),
      );
    });

    it('rolls back a start whose secret cannot be encrypted', async () => {
      config.jwt_refresh_secret = '';
      try {
        await expect(rejection(start())).resolves.toMatchObject({
          status: 503,
        });
      } finally {
        config.jwt_refresh_secret = 'mfa-service-unit-test-refresh-secret-0123';
      }
      expect(repo.enrollments.has(USER)).toBe(false);
    });
  });

  it('never logs a secret or a code', async () => {
    const { secret } = await start();
    const code = totpCode(secret, T0);
    await rejection(confirm(wrongCode(code)));
    await confirm(code);

    const logged = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(wrongCode(code));
  });
});
