import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { InMemoryMfaEnrollments } from '../../../test/support/in-memory-mfa-enrollments';
import config from '../../common/config/app.config';
import type { ActivityLogService } from '../../common/services/activity-log.service';
import { MfaRecoveryCodeHasher } from './mfa-recovery-code.hasher';
import { MfaSecretCipher } from './mfa-secret.cipher';
import { MfaService } from './mfa.service';
import { totpCode, totpTimeStep } from './totp';

const META = { ip: '203.0.113.9', userAgent: 'jest', device: 'phone' };
const MIN = 60_000;
/** The start of a 30-second TOTP step, so offsets inside it are predictable. */
const T0 = new Date(Math.floor(Date.UTC(2026, 10, 22, 12) / 30_000) * 30_000);
const at = (ms: number) => new Date(T0.getTime() + ms);

/** The authenticator's code at `now`, and a code that is certainly wrong. */
const codeAt = (secret: string, now: Date) =>
  totpCode(secret, totpTimeStep(now));
const wrongCodeAt = (secret: string, now: Date) => {
  const right = codeAt(secret, now);
  return right === '000000' ? '111111' : '000000';
};

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), message: error.message };
    }
    throw error;
  }
  throw new Error('Expected the promise to be rejected');
}

describe('MfaService (mfa)', () => {
  let store: InMemoryMfaEnrollments;
  let cipher: MfaSecretCipher;
  let hasher: MfaRecoveryCodeHasher;
  let activityLog: ReturnType<typeof mock<ActivityLogService>>;
  let logger: ReturnType<typeof mock<Logger>>;
  let service: MfaService;
  const originalRefreshSecret = config.jwt_refresh_secret;

  beforeEach(() => {
    config.jwt_refresh_secret = 'mfa-service-spec-refresh-secret-0123456789';
    store = new InMemoryMfaEnrollments();
    const configService = new ConfigService({
      MFA_ENCRYPTION_KEY: 'mfa-service-spec-dedicated-key-0123456789',
    });
    cipher = new MfaSecretCipher(configService);
    hasher = new MfaRecoveryCodeHasher(configService);
    activityLog = mock<ActivityLogService>();
    logger = mock<Logger>();
    service = new MfaService(
      store.asRepository(),
      store.asCredentialsRepository(),
      cipher,
      hasher,
      activityLog,
      logger,
    );
  });
  afterAll(() => {
    config.jwt_refresh_secret = originalRefreshSecret;
  });

  describe('status', () => {
    it('reports MFA as disabled with no enrollment for a new account', async () => {
      const user = store.addUser();
      await expect(service.getStatus(user.account.authId, T0)).resolves.toEqual(
        {
          enabled: false,
          method: null,
          enabledAt: null,
          enrollment: {
            status: 'NONE',
            expiresAt: null,
            blockedUntil: null,
            remainingAttempts: 5,
          },
          recovery: null,
          verification: null,
        },
      );
    });

    it('refuses unknown and inactive accounts', async () => {
      const inactive = store.addUser({ status: 'PENDING_DELETION' });
      expect(await rejection(service.getStatus('missing', T0))).toMatchObject({
        status: 401,
      });
      expect(
        await rejection(service.getStatus(inactive.account.authId, T0)),
      ).toMatchObject({ status: 401 });
      expect(
        await rejection(service.startEnrollment(inactive.account.authId, T0)),
      ).toMatchObject({ status: 401 });
    });
  });

  describe('starting an enrollment', () => {
    it('returns a new secret for the authenticator, pending for 10 minutes', async () => {
      const user = store.addUser({ email: 'owner@example.com' });
      const view = await service.startEnrollment(user.account.authId, T0);

      expect(view).toMatchObject({
        method: 'totp',
        secret: expect.stringMatching(/^[A-Z2-7]{32}$/) as unknown,
        issuer: 'MuseCue',
        accountName: 'owner@example.com',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        expiresAt: at(10 * MIN),
      });
      expect(view.otpauthUrl).toBe(
        `otpauth://totp/MuseCue:owner%40example.com?secret=${view.secret}&issuer=MuseCue&algorithm=SHA1&digits=6&period=30`,
      );
      await expect(
        service.getStatus(user.account.authId, at(MIN)),
      ).resolves.toMatchObject({
        enabled: false,
        enrollment: { status: 'PENDING', expiresAt: at(10 * MIN) },
      });
    });

    it('stores the pending secret only encrypted, bound to the user', async () => {
      const user = store.addUser();
      const { secret } = await service.startEnrollment(user.account.authId, T0);

      const stored = store.get(user.account.authId).enrollment?.secret;
      expect(stored).toMatch(/^v1\./);
      expect(stored).not.toContain(secret);
      expect(cipher.decrypt(user.account.authId, 'enrollment', stored!)).toBe(
        secret,
      );
      expect(() =>
        cipher.decrypt('someone-else', 'enrollment', stored!),
      ).toThrow();
    });

    it('replaces the secret of a restarted enrollment (the old one stops working)', async () => {
      const user = store.addUser();
      const first = await service.startEnrollment(user.account.authId, T0);
      const second = await service.startEnrollment(
        user.account.authId,
        at(5_000),
      );
      expect(second.secret).not.toBe(first.secret);
      expect(second.expiresAt).toEqual(at(5_000 + 10 * MIN));

      const now = at(6_000);
      const oldCode = codeAt(first.secret, now);
      if (oldCode !== codeAt(second.secret, now)) {
        expect(
          await rejection(
            service.confirmEnrollment(user.account.authId, oldCode, META, now),
          ),
        ).toMatchObject({ status: 400 });
      }
    });

    it('never logs the secret', async () => {
      const user = store.addUser();
      const { secret } = await service.startEnrollment(user.account.authId, T0);
      await service.confirmEnrollment(
        user.account.authId,
        codeAt(secret, T0),
        META,
        T0,
      );
      const logged = JSON.stringify([
        logger.info.mock.calls,
        logger.warn.mock.calls,
        logger.error.mock.calls,
        activityLog.logActivity.mock.calls,
      ]);
      expect(logged).not.toContain(secret);
    });
  });

  describe('confirming an enrollment', () => {
    it('enables MFA with the current code and stores the secret encrypted', async () => {
      const user = store.addUser();
      const authId = user.account.authId;
      const { secret } = await service.startEnrollment(authId, T0);
      const now = at(MIN);

      const status = await service.confirmEnrollment(
        authId,
        codeAt(secret, now),
        META,
        now,
      );

      const { recoveryCodes, ...statusWithoutCodes } = status;
      expect(statusWithoutCodes).toEqual({
        enabled: true,
        method: 'totp',
        enabledAt: now,
        enrollment: null,
        recovery: { remainingCodes: 10, generatedAt: now },
        verification: { remainingAttempts: 5, blockedUntil: null },
      });
      expect(recoveryCodes).toHaveLength(10);
      const stored = store.get(authId);
      expect(stored.account).toMatchObject({
        mfaEnabled: true,
        mfaMethod: 'totp',
      });
      expect(stored.enrollment).toBeNull();
      expect(stored.mfaSecret).toMatch(/^v1\./);
      expect(stored.mfaSecret).not.toContain(secret);
      expect(cipher.decrypt(authId, 'active', stored.mfaSecret!)).toBe(secret);
      // The confirming code's step is recorded and can never be used again.
      expect(stored.mfaLastUsedStep).toBe(totpTimeStep(now));
      expect(activityLog.logActivity.mock.calls).toEqual([
        [
          expect.objectContaining({
            tableName: 'authUser',
            recordId: authId,
            changes: [
              { fieldName: 'mfaEnabled', oldValue: 'false', newValue: 'true' },
              { fieldName: 'mfaMethod', oldValue: null, newValue: 'totp' },
              {
                fieldName: 'mfaRecoveryCodesRemaining',
                oldValue: null,
                newValue: '10',
              },
            ],
            metadata: { ...META, actionedBy: authId },
          }),
          expect.anything(),
        ],
      ]);
      // The status never contains the recovery codes again.
      await expect(service.getStatus(authId, now)).resolves.toEqual(
        statusWithoutCodes,
      );
    });

    it('accepts a code for the rest of its 30-second step', async () => {
      const user = store.addUser();
      const { secret } = await service.startEnrollment(user.account.authId, T0);
      const issued = at(30_000); // start of a step
      const code = codeAt(secret, issued);
      await expect(
        service.confirmEnrollment(
          user.account.authId,
          code,
          META,
          at(30_000 + 29_999),
        ),
      ).resolves.toMatchObject({ enabled: true });
    });

    it('rejects a code after its 30 seconds (expired) and counts it', async () => {
      const user = store.addUser();
      const authId = user.account.authId;
      const { secret } = await service.startEnrollment(authId, T0);
      const code = codeAt(secret, at(1_000));
      const later = at(30_000);
      // (Skip the vanishingly rare case of two consecutive equal codes.)
      if (code === codeAt(secret, later)) return;

      expect(
        await rejection(service.confirmEnrollment(authId, code, META, later)),
      ).toEqual({
        status: 400,
        message: 'Invalid or expired authentication code',
      });
      await expect(service.getStatus(authId, later)).resolves.toMatchObject({
        enabled: false,
        enrollment: { status: 'PENDING', remainingAttempts: 4 },
      });
      // The current code still works.
      await expect(
        service.confirmEnrollment(authId, codeAt(secret, later), META, later),
      ).resolves.toMatchObject({ enabled: true });
    });

    it('rejects reuse of a code once MFA is enabled (409), without counting it', async () => {
      const user = store.addUser();
      const authId = user.account.authId;
      const { secret } = await service.startEnrollment(authId, T0);
      const code = codeAt(secret, T0);
      await service.confirmEnrollment(authId, code, META, T0);

      expect(
        await rejection(service.confirmEnrollment(authId, code, META, T0)),
      ).toMatchObject({ status: 409 });
      expect(
        await rejection(service.startEnrollment(authId, T0)),
      ).toMatchObject({
        status: 409,
        message: 'MFA is already enabled for this account',
      });
    });

    it('confirms exactly once when the same code is submitted concurrently', async () => {
      const user = store.addUser();
      const authId = user.account.authId;
      const { secret } = await service.startEnrollment(authId, T0);
      const code = codeAt(secret, T0);

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          service.confirmEnrollment(authId, code, META, T0),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(
        refused.map((r) => (r.reason as HttpException).getStatus()),
      ).toEqual([409, 409, 409, 409]);
      expect(activityLog.logActivity.mock.calls).toHaveLength(1);
    });

    it('refuses confirmation without a started enrollment (404), without counting it', async () => {
      const user = store.addUser();
      expect(
        await rejection(
          service.confirmEnrollment(user.account.authId, '123456', META, T0),
        ),
      ).toEqual({
        status: 404,
        message: 'No MFA enrollment in progress. Start a new enrollment.',
      });
      await expect(
        service.getStatus(user.account.authId, T0),
      ).resolves.toMatchObject({ enrollment: { remainingAttempts: 5 } });
    });

    it('expires the enrollment after 10 minutes (410), without counting it', async () => {
      const user = store.addUser();
      const authId = user.account.authId;
      const { secret } = await service.startEnrollment(authId, T0);
      const expired = at(10 * MIN);

      expect(
        await rejection(
          service.confirmEnrollment(
            authId,
            codeAt(secret, expired),
            META,
            expired,
          ),
        ),
      ).toEqual({
        status: 410,
        message: 'The MFA enrollment has expired. Start a new enrollment.',
      });
      await expect(service.getStatus(authId, expired)).resolves.toMatchObject({
        enabled: false,
        enrollment: {
          status: 'EXPIRED',
          expiresAt: expired,
          remainingAttempts: 5,
        },
      });
      expect(store.get(authId).account.mfaEnabled).toBe(false);
    });

    it('still accepts a valid code just before the 10 minutes are over', async () => {
      const user = store.addUser();
      const { secret } = await service.startEnrollment(user.account.authId, T0);
      const lastMoment = at(10 * MIN - 1);
      await expect(
        service.confirmEnrollment(
          user.account.authId,
          codeAt(secret, lastMoment),
          META,
          lastMoment,
        ),
      ).resolves.toMatchObject({ enabled: true });
    });

    it('blocks enrollment for 15 minutes after 5 incorrect codes within 15 minutes', async () => {
      const user = store.addUser();
      const authId = user.account.authId;
      const { secret } = await service.startEnrollment(authId, T0);
      const wrong = wrongCodeAt(secret, T0);

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        expect(
          await rejection(
            service.confirmEnrollment(authId, wrong, META, at(attempt * 1_000)),
          ),
        ).toMatchObject({ status: 400 });
      }
      const fifth = at(5_000);
      expect(
        await rejection(service.confirmEnrollment(authId, wrong, META, fifth)),
      ).toEqual({
        status: 429,
        message:
          'Too many incorrect authentication codes. MFA enrollment is blocked; try again in 15 minutes.',
      });

      // Blocked: even the correct code and a new enrollment are refused.
      const during = at(5_000 + 14 * MIN);
      expect(
        await rejection(
          service.confirmEnrollment(
            authId,
            codeAt(secret, during),
            META,
            during,
          ),
        ),
      ).toMatchObject({ status: 429 });
      expect(await rejection(service.startEnrollment(authId, during))).toEqual({
        status: 429,
        message:
          'Too many incorrect authentication codes. MFA enrollment is blocked; try again in 1 minute.',
      });
      await expect(service.getStatus(authId, during)).resolves.toMatchObject({
        enabled: false,
        enrollment: {
          status: 'BLOCKED',
          blockedUntil: at(5_000 + 15 * MIN),
          remainingAttempts: 0,
        },
      });
      expect(store.get(authId).enrollment?.secret).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'MFA enrollment blocked after repeated incorrect codes',
        expect.objectContaining({ userId: authId }),
      );

      // After the block a new enrollment works, with fresh attempts.
      const after = at(5_000 + 15 * MIN);
      const restarted = await service.startEnrollment(authId, after);
      await expect(service.getStatus(authId, after)).resolves.toMatchObject({
        enrollment: { status: 'PENDING', remainingAttempts: 5 },
      });
      await expect(
        service.confirmEnrollment(
          authId,
          codeAt(restarted.secret, after),
          META,
          after,
        ),
      ).resolves.toMatchObject({ enabled: true });
    });

    it('does not block when the incorrect codes are spread over more than 15 minutes', async () => {
      const user = store.addUser();
      const authId = user.account.authId;
      let { secret } = await service.startEnrollment(authId, T0);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await rejection(
          service.confirmEnrollment(authId, wrongCodeAt(secret, T0), META, T0),
        );
      }
      // The enrollment expired meanwhile; restart it and miss once more.
      const later = at(15 * MIN);
      ({ secret } = await service.startEnrollment(authId, later));
      expect(
        await rejection(
          service.confirmEnrollment(
            authId,
            wrongCodeAt(secret, later),
            META,
            later,
          ),
        ),
      ).toMatchObject({ status: 400 });
      await expect(service.getStatus(authId, later)).resolves.toMatchObject({
        enrollment: { status: 'PENDING', remainingAttempts: 4 },
      });
    });

    it('does not reset the counter when the enrollment is restarted', async () => {
      const user = store.addUser();
      const authId = user.account.authId;
      let { secret } = await service.startEnrollment(authId, T0);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await rejection(
          service.confirmEnrollment(authId, wrongCodeAt(secret, T0), META, T0),
        );
      }
      ({ secret } = await service.startEnrollment(authId, at(MIN)));
      await rejection(
        service.confirmEnrollment(
          authId,
          wrongCodeAt(secret, at(MIN)),
          META,
          at(MIN),
        ),
      );
      expect(
        await rejection(
          service.confirmEnrollment(
            authId,
            wrongCodeAt(secret, at(MIN)),
            META,
            at(MIN),
          ),
        ),
      ).toMatchObject({ status: 429 });
    });

    it("only ever touches the caller's own enrollment", async () => {
      const owner = store.addUser();
      const other = store.addUser();
      const { secret } = await service.startEnrollment(
        owner.account.authId,
        T0,
      );

      // The owner's valid code does nothing for another account.
      expect(
        await rejection(
          service.confirmEnrollment(
            other.account.authId,
            codeAt(secret, T0),
            META,
            T0,
          ),
        ),
      ).toMatchObject({ status: 404 });
      expect(store.get(owner.account.authId).account.mfaEnabled).toBe(false);
      expect(store.get(other.account.authId).account.mfaEnabled).toBe(false);
      await expect(
        service.getStatus(owner.account.authId, T0),
      ).resolves.toMatchObject({
        enrollment: { status: 'PENDING', remainingAttempts: 5 },
      });
    });

    it('treats a pending secret that can no longer be decrypted as expired', async () => {
      const user = store.addUser();
      const authId = user.account.authId;
      const { secret } = await service.startEnrollment(authId, T0);
      // The key changed after the enrollment started.
      const rotated = new MfaService(
        store.asRepository(),
        store.asCredentialsRepository(),
        new MfaSecretCipher(
          new ConfigService({
            MFA_ENCRYPTION_KEY: 'a-different-key-0123456789abcdefghij',
          }),
        ),
        hasher,
        activityLog,
        logger,
      );
      expect(
        await rejection(
          rotated.confirmEnrollment(authId, codeAt(secret, T0), META, T0),
        ),
      ).toMatchObject({ status: 410 });
      expect(store.get(authId).enrollment?.secret).toBeNull();
      expect(store.get(authId).account.mfaEnabled).toBe(false);
    });

    it('fails closed (503) when no encryption key is configured', async () => {
      const user = store.addUser();
      const unconfigured = new MfaService(
        store.asRepository(),
        store.asCredentialsRepository(),
        new MfaSecretCipher(new ConfigService({ MFA_ENCRYPTION_KEY: 'short' })),
        hasher,
        activityLog,
        logger,
      );
      expect(
        await rejection(unconfigured.startEnrollment(user.account.authId, T0)),
      ).toEqual({ status: 503, message: 'MFA is temporarily unavailable' });
      expect(store.get(user.account.authId).enrollment).toBeNull();
    });

    it('commits nothing when the audit log write fails', async () => {
      const user = store.addUser();
      const authId = user.account.authId;
      const { secret } = await service.startEnrollment(authId, T0);
      activityLog.logActivity.mockRejectedValueOnce(new Error('db down'));

      await expect(
        service.confirmEnrollment(authId, codeAt(secret, T0), META, T0),
      ).rejects.toThrow('db down');
      expect(store.get(authId).account.mfaEnabled).toBe(false);
      expect(store.get(authId).mfaSecret).toBeNull();
      expect(store.get(authId).enrollment?.secret).toMatch(/^v1\./);
    });
  });
});
