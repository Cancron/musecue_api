import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { InMemoryMfaEnrollments } from '../../../test/support/in-memory-mfa-enrollments';
import config from '../../common/config/app.config';
import type { ActivityLogService } from '../../common/services/activity-log.service';
import { MfaRecoveryCodeHasher } from './mfa-recovery-code.hasher';
import { MfaSecretCipher } from './mfa-secret.cipher';
import { MfaVerificationService } from './mfa-verification.service';
import { MfaService } from './mfa.service';
import { totpCode, totpTimeStep } from './totp';

const META = { ip: '203.0.113.9', userAgent: 'jest' };
const MIN = 60_000;
const T0 = new Date(Math.floor(Date.UTC(2026, 10, 23, 12) / 30_000) * 30_000);
const at = (ms: number) => new Date(T0.getTime() + ms);
const codeAt = (secret: string, now: Date) =>
  totpCode(secret, totpTimeStep(now));

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

const INVALID = {
  status: 400,
  message: 'Invalid or expired authentication code',
};

describe('MfaVerificationService (mfa recovery codes)', () => {
  let store: InMemoryMfaEnrollments;
  let activityLog: ReturnType<typeof mock<ActivityLogService>>;
  let logger: ReturnType<typeof mock<Logger>>;
  let hasher: MfaRecoveryCodeHasher;
  let mfa: MfaService;
  let verification: MfaVerificationService;
  const originalRefresh = config.jwt_refresh_secret;

  beforeEach(() => {
    config.jwt_refresh_secret = 'mfa-verification-spec-refresh-0123456789';
    store = new InMemoryMfaEnrollments();
    activityLog = mock<ActivityLogService>();
    logger = mock<Logger>();
    const configService = new ConfigService({
      MFA_ENCRYPTION_KEY: 'mfa-verification-spec-key-0123456789abcdef',
    });
    const cipher = new MfaSecretCipher(configService);
    hasher = new MfaRecoveryCodeHasher(configService);
    mfa = new MfaService(
      store.asRepository(),
      store.asCredentialsRepository(),
      cipher,
      hasher,
      activityLog,
      logger,
    );
    verification = new MfaVerificationService(
      store.asCredentialsRepository(),
      cipher,
      hasher,
      activityLog,
      logger,
    );
  });
  afterAll(() => {
    config.jwt_refresh_secret = originalRefresh;
  });

  /** A user who enabled MFA at T0: their authenticator secret and recovery codes. */
  async function enabledUser() {
    const user = store.addUser();
    const authId = user.account.authId;
    const { secret } = await mfa.startEnrollment(authId, T0);
    const { recoveryCodes } = await mfa.confirmEnrollment(
      authId,
      codeAt(secret, T0),
      META,
      T0,
    );
    return { authId, secret, codes: recoveryCodes };
  }

  const usable = (authId: string) =>
    store
      .get(authId)
      .recoveryCodes.filter(
        (c) => c.usedAt === null && c.invalidatedAt === null,
      );

  describe('issuing codes on enrollment', () => {
    it('returns 10 unique codes once and stores only their hashes', async () => {
      const { authId, codes } = await enabledUser();
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      const stored = store.get(authId).recoveryCodes;
      expect(stored).toHaveLength(10);
      expect(new Set(stored.map((c) => c.batchId)).size).toBe(1);
      expect(stored.map((c) => c.codeHash).sort()).toEqual(
        codes.map((c) => hasher.hash(authId, c)).sort(),
      );
      const serialized = JSON.stringify(stored);
      for (const code of codes) {
        expect(serialized).not.toContain(code);
        expect(serialized).not.toContain(code.replace(/-/g, ''));
      }
      // The status only reports how many are left.
      const status = await mfa.getStatus(authId, T0);
      expect(status.recovery).toEqual({ remainingCodes: 10, generatedAt: T0 });
      expect(JSON.stringify(status)).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}-/);
    });
  });

  describe('verifying with a recovery code', () => {
    it('accepts an unused code instead of the authenticator, once', async () => {
      const { authId, codes } = await enabledUser();

      await expect(
        verification.verify(authId, { recoveryCode: codes[3] }, META, at(MIN)),
      ).resolves.toEqual({
        verified: true,
        method: 'recovery_code',
        remainingRecoveryCodes: 9,
      });
      const used = store
        .get(authId)
        .recoveryCodes.find(
          (c) => c.codeHash === hasher.hash(authId, codes[3]),
        );
      expect(used?.usedAt).toEqual(at(MIN));
      expect(used?.invalidatedAt).toBeNull();

      // Already used: refused (and counted).
      expect(
        await rejection(
          verification.verify(
            authId,
            { recoveryCode: codes[3] },
            META,
            at(MIN),
          ),
        ),
      ).toEqual(INVALID);
      expect(store.get(authId).counter.failedAttempts).toBe(1);
      expect(
        (await mfa.getStatus(authId, at(MIN))).recovery?.remainingCodes,
      ).toBe(9);
    });

    it('accepts the code however it is typed', async () => {
      const { authId, codes } = await enabledUser();
      const typed = ` ${codes[0].replace(/-/g, ' ').toLowerCase()} `;
      await expect(
        verification.verify(authId, { recoveryCode: typed }, META, T0),
      ).resolves.toMatchObject({ method: 'recovery_code' });
    });

    it("refuses another account's code and leaves it unused", async () => {
      const owner = await enabledUser();
      const other = await enabledUser();

      expect(
        await rejection(
          verification.verify(
            other.authId,
            { recoveryCode: owner.codes[0] },
            META,
            T0,
          ),
        ),
      ).toEqual(INVALID);
      expect(usable(owner.authId)).toHaveLength(10);
      expect(usable(other.authId)).toHaveLength(10);
      // The owner can still use it.
      await expect(
        verification.verify(
          owner.authId,
          { recoveryCode: owner.codes[0] },
          META,
          T0,
        ),
      ).resolves.toMatchObject({ verified: true });
    });

    it.each(['ABCD-2345-WXYZ', 'ABCD-2345-WXYU', '0000-0000-0000'])(
      'refuses the invalid code %s and counts it',
      async (code) => {
        const { authId } = await enabledUser();
        expect(
          await rejection(
            verification.verify(authId, { recoveryCode: code }, META, T0),
          ),
        ).toEqual(INVALID);
        expect(store.get(authId).counter.failedAttempts).toBe(1);
        expect(usable(authId)).toHaveLength(10);
      },
    );

    it('lets exactly one of concurrent requests with the same code succeed', async () => {
      const { authId, codes } = await enabledUser();

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          verification.verify(authId, { recoveryCode: codes[0] }, META, T0),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => (r.reason as HttpException).getStatus()),
      ).toEqual([400, 400, 400, 400]);
      expect(usable(authId)).toHaveLength(9);
    });

    it('accepts concurrent requests with different codes', async () => {
      const { authId, codes } = await enabledUser();
      const results = await Promise.all(
        codes
          .slice(0, 4)
          .map((code) =>
            verification.verify(authId, { recoveryCode: code }, META, T0),
          ),
      );
      expect(results.every((r) => r.verified)).toBe(true);
      expect(usable(authId)).toHaveLength(6);
    });

    it('audits the use without the code and never logs a code', async () => {
      const { authId, codes } = await enabledUser();
      await verification.verify(authId, { recoveryCode: codes[0] }, META, T0);
      await verification.regenerateRecoveryCodes(
        authId,
        { recoveryCode: codes[1] },
        META,
        T0,
      );
      expect(activityLog.logActivity.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              changes: [
                {
                  fieldName: 'mfaRecoveryCodesRemaining',
                  oldValue: '10',
                  newValue: '9',
                },
              ],
            }),
            expect.anything(),
          ],
        ]),
      );
      const logged = JSON.stringify([
        logger.info.mock.calls,
        logger.warn.mock.calls,
        logger.error.mock.calls,
        logger.debug.mock.calls,
        activityLog.logActivity.mock.calls,
      ]);
      for (const code of codes) {
        expect(logged).not.toContain(code);
        expect(logged).not.toContain(code.replace(/-/g, ''));
      }
    });

    it('commits nothing when the audit write fails (the code stays usable)', async () => {
      const { authId, codes } = await enabledUser();
      activityLog.logActivity.mockRejectedValueOnce(new Error('db down'));
      await expect(
        verification.verify(authId, { recoveryCode: codes[0] }, META, T0),
      ).rejects.toThrow('db down');
      expect(usable(authId)).toHaveLength(10);
    });
  });

  describe('verifying with the authenticator', () => {
    it('accepts the current code once per time step, and never the enrollment code', async () => {
      const { authId, secret } = await enabledUser();
      // The code that enabled MFA (same step) was already used.
      expect(
        await rejection(
          verification.verify(authId, { code: codeAt(secret, T0) }, META, T0),
        ),
      ).toEqual(INVALID);

      const later = at(30_000);
      await expect(
        verification.verify(
          authId,
          { code: codeAt(secret, later) },
          META,
          later,
        ),
      ).resolves.toEqual({
        verified: true,
        method: 'totp',
        remainingRecoveryCodes: 10,
      });
      expect(store.get(authId).mfaLastUsedStep).toBe(totpTimeStep(later));
      expect(
        await rejection(
          verification.verify(
            authId,
            { code: codeAt(secret, later) },
            META,
            later,
          ),
        ),
      ).toEqual(INVALID);
    });
  });

  describe('regenerating recovery codes', () => {
    it('replaces every earlier code after verifying the authenticator', async () => {
      const { authId, secret, codes } = await enabledUser();
      await verification.verify(authId, { recoveryCode: codes[0] }, META, T0);
      const now = at(30_000);

      const fresh = await verification.regenerateRecoveryCodes(
        authId,
        { code: codeAt(secret, now) },
        META,
        now,
      );

      expect(fresh).toMatchObject({
        generatedAt: now,
        remainingRecoveryCodes: 10,
        verifiedWith: 'totp',
      });
      expect(fresh.recoveryCodes).toHaveLength(10);
      expect(fresh.recoveryCodes.some((c) => codes.includes(c))).toBe(false);
      const stored = store.get(authId).recoveryCodes;
      expect(stored).toHaveLength(20);
      expect(
        stored
          .filter((c) => c.invalidatedAt !== null)
          .map((c) => c.invalidatedAt),
      ).toEqual(Array(10).fill(now));
      expect(usable(authId)).toHaveLength(10);

      // Every earlier code (used or not) is refused; the new ones work.
      for (const old of codes.slice(0, 3)) {
        expect(
          await rejection(
            verification.verify(authId, { recoveryCode: old }, META, now),
          ),
        ).toEqual(INVALID);
      }
      await expect(
        verification.verify(
          authId,
          { recoveryCode: fresh.recoveryCodes[0] },
          META,
          now,
        ),
      ).resolves.toMatchObject({ remainingRecoveryCodes: 9 });
    });

    it('can be authorized by a recovery code (which is consumed first)', async () => {
      const { authId, codes } = await enabledUser();
      const fresh = await verification.regenerateRecoveryCodes(
        authId,
        { recoveryCode: codes[0] },
        META,
        T0,
      );
      expect(fresh.verifiedWith).toBe('recovery_code');
      expect(
        store
          .get(authId)
          .recoveryCodes.find(
            (c) => c.codeHash === hasher.hash(authId, codes[0]),
          ),
      ).toMatchObject({ usedAt: T0, invalidatedAt: T0 });
    });

    it('regenerates nothing when the factor is wrong', async () => {
      const { authId, codes } = await enabledUser();
      expect(
        await rejection(
          verification.regenerateRecoveryCodes(
            authId,
            { recoveryCode: 'ABCD-2345-WXYZ' },
            META,
            T0,
          ),
        ),
      ).toEqual(INVALID);
      expect(store.get(authId).recoveryCodes).toHaveLength(10);
      await expect(
        verification.verify(authId, { recoveryCode: codes[0] }, META, T0),
      ).resolves.toMatchObject({ verified: true });
    });
  });

  describe('limits', () => {
    it('refuses verification while MFA is not enabled', async () => {
      const user = store.addUser();
      expect(
        await rejection(
          verification.verify(
            user.account.authId,
            { recoveryCode: 'ABCD-2345-WXYZ' },
            META,
            T0,
          ),
        ),
      ).toEqual({
        status: 409,
        message: 'MFA is not enabled for this account',
      });
    });

    it('blocks verification for 15 minutes after 5 incorrect codes within 15 minutes', async () => {
      const { authId, codes } = await enabledUser();
      for (let i = 1; i <= 4; i += 1) {
        expect(
          await rejection(
            verification.verify(
              authId,
              { recoveryCode: 'ABCD-2345-WXYZ' },
              META,
              at(i * 1_000),
            ),
          ),
        ).toEqual(INVALID);
      }
      expect(
        await rejection(
          verification.verify(authId, { code: '000000' }, META, at(5_000)),
        ),
      ).toEqual({
        status: 429,
        message:
          'Too many incorrect authentication codes. MFA verification is blocked; try again in 15 minutes.',
      });
      // Even a valid code is refused (and not consumed) while blocked.
      expect(
        await rejection(
          verification.verify(
            authId,
            { recoveryCode: codes[0] },
            META,
            at(MIN),
          ),
        ),
      ).toMatchObject({ status: 429 });
      expect(usable(authId)).toHaveLength(10);
      expect((await mfa.getStatus(authId, at(MIN))).verification).toEqual({
        remainingAttempts: 0,
        blockedUntil: at(5_000 + 15 * MIN),
      });

      const after = at(5_000 + 15 * MIN);
      await expect(
        verification.verify(authId, { recoveryCode: codes[0] }, META, after),
      ).resolves.toMatchObject({ verified: true });
      expect((await mfa.getStatus(authId, after)).verification).toEqual({
        remainingAttempts: 5,
        blockedUntil: null,
      });
    });

    it('resets the counter after a successful verification', async () => {
      const { authId, codes } = await enabledUser();
      for (let i = 0; i < 3; i += 1) {
        await rejection(
          verification.verify(
            authId,
            { recoveryCode: 'ABCD-2345-WXYZ' },
            META,
            T0,
          ),
        );
      }
      await verification.verify(authId, { recoveryCode: codes[0] }, META, T0);
      expect(store.get(authId).counter).toEqual({
        failedAttempts: 0,
        failureWindowStartedAt: null,
        blockedUntil: null,
      });
    });

    it('refuses inactive and unknown accounts', async () => {
      const { authId, codes } = await enabledUser();
      store.get(authId).account.status = 'SUSPENDED';
      expect(
        await rejection(
          verification.verify(authId, { recoveryCode: codes[0] }, META, T0),
        ),
      ).toMatchObject({ status: 401 });
      expect(
        await rejection(
          verification.verify('missing', { recoveryCode: codes[0] }, META, T0),
        ),
      ).toMatchObject({ status: 401 });
    });

    it('answers 503 (and counts nothing) when the stored secret cannot be decrypted', async () => {
      const { authId, secret } = await enabledUser();
      const rotated = new MfaVerificationService(
        store.asCredentialsRepository(),
        new MfaSecretCipher(
          new ConfigService({
            MFA_ENCRYPTION_KEY: 'another-key-0123456789abcdefghijkl',
          }),
        ),
        hasher,
        activityLog,
        logger,
      );
      const later = at(30_000);
      expect(
        await rejection(
          rotated.verify(authId, { code: codeAt(secret, later) }, META, later),
        ),
      ).toEqual({ status: 503, message: 'MFA is temporarily unavailable' });
      expect(store.get(authId).counter.failedAttempts).toBe(0);
    });
  });
});
