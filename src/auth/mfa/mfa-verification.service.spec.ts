import { HttpException } from '@nestjs/common';
import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { FakeMfaRepository } from '../../../test/support/fake-mfa-repository';
import config from '../../common/config/app.config';
import {
  hashesMatchCodes,
  testCipher,
} from '../../../test/support/mfa-test-keys';
import { verifyRecoveryCode } from './mfa-recovery-codes';
import { totpCode, totpStep } from './mfa-totp';
import {
  MfaVerificationService,
  type MfaFactor,
} from './mfa-verification.service';
import { MfaService } from './mfa.service';
import { FakeMfaNotifier } from '../../../test/support/fake-mfa-notifier';

// Recovery codes use salted scrypt (deliberately slow, ~50-80 ms each), so
// tests that issue and verify many codes need more than the 5 s default
// when run alongside other suites.
jest.setTimeout(30_000);

const ALICE = 'alice';
const BOB = 'bob';
const META = { ip: '203.0.113.9', userAgent: 'jest' };
/** The start of a 30-second TOTP step. */
const T0 = new Date(Math.floor(Date.UTC(2026, 10, 23, 8) / 30_000) * 30_000);
const plus = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

const recovery = (code: string): MfaFactor => ({
  method: 'recovery_code',
  code,
});
const totp = (code: string): MfaFactor => ({ method: 'totp', code });

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), message: error.message };
  }
  throw new Error('Expected the call to be rejected');
}

describe('MfaVerificationService', () => {
  const originalSecret = config.jwt_refresh_secret;
  let repo: FakeMfaRepository;
  let logger: ReturnType<typeof mock<Logger>>;
  let enrollment: MfaService;
  let service: MfaVerificationService;

  beforeAll(() => {
    // MFA must not depend on the JWT refresh secret: run without one.
    config.jwt_refresh_secret = '';
  });
  afterAll(() => {
    config.jwt_refresh_secret = originalSecret;
  });

  let notifier: FakeMfaNotifier;

  beforeEach(() => {
    notifier = new FakeMfaNotifier();
    repo = new FakeMfaRepository();
    repo.addAccount(ALICE);
    repo.addAccount(BOB);
    logger = mock<Logger>();
    const cipher = testCipher();
    enrollment = new MfaService(
      repo.asRepository(),
      cipher,
      notifier.asNotifier(),
      logger,
    );
    service = new MfaVerificationService(
      repo.asRepository(),
      cipher,
      notifier.asNotifier(),
      logger,
    );
  });

  /** Enables MFA at T0 and returns the TOTP secret and recovery codes. */
  async function enable(authId = ALICE) {
    const { secret } = await enrollment.startEnrollment(authId, T0);
    const { recoveryCodes } = await enrollment.confirmEnrollment(
      authId,
      totpCode(secret, T0),
      META,
      T0,
    );
    return { secret, recoveryCodes };
  }

  const verify = (factor: MfaFactor, now = plus(MIN), authId = ALICE) =>
    service.verify(authId, factor, META, now);

  describe('with a recovery code', () => {
    it('verifies and consumes exactly that code', async () => {
      const { recoveryCodes } = await enable();

      await expect(verify(recovery(recoveryCodes[3]))).resolves.toEqual({
        verified: true,
        method: 'recovery_code',
        recoveryCodesRemaining: 9,
      });

      const stored = repo.recoveryCodes.get(ALICE)!;
      const used = stored.filter((c) => c.usedAt);
      expect(used).toHaveLength(1);
      expect(used[0].usedAt).toEqual(plus(MIN));
      await expect(
        verifyRecoveryCode(ALICE, recoveryCodes[3], used[0].codeHash),
      ).resolves.toBe(true);
    });

    it('accepts the code typed in lower case or without the hyphen', async () => {
      const { recoveryCodes } = await enable();
      await verify(recovery(recoveryCodes[0].toLowerCase()));
      await verify(recovery(recoveryCodes[1].replace('-', '')));
      expect(repo.unusedCodes(ALICE)).toHaveLength(8);
    });

    it('declines an already used code, and counts it', async () => {
      const { recoveryCodes } = await enable();
      await verify(recovery(recoveryCodes[0]));

      await expect(
        rejection(verify(recovery(recoveryCodes[0]), plus(2 * MIN))),
      ).resolves.toEqual({
        status: 400,
        message: 'Invalid MFA code. 4 attempt(s) remaining.',
      });
      expect(repo.unusedCodes(ALICE)).toHaveLength(9);
    });

    it('does not affect the other codes: all ten work, once each', async () => {
      const { recoveryCodes } = await enable();

      for (const [i, code] of recoveryCodes.entries()) {
        await expect(
          verify(recovery(code), plus(MIN + i)),
        ).resolves.toMatchObject({ recoveryCodesRemaining: 9 - i });
      }
      expect(repo.unusedCodes(ALICE)).toHaveLength(0);
    });

    it('accepts exactly one of concurrent uses of the same code', async () => {
      const { recoveryCodes } = await enable();

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => verify(recovery(recoveryCodes[0]))),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(repo.unusedCodes(ALICE)).toHaveLength(9);
    });

    it('accepts concurrent uses of different codes', async () => {
      const { recoveryCodes } = await enable();

      const results = await Promise.all(
        recoveryCodes.slice(0, 4).map((code) => verify(recovery(code))),
      );

      expect(results.every((r) => r.verified)).toBe(true);
      expect(repo.unusedCodes(ALICE)).toHaveLength(6);
    });

    it('declines a code that was never issued', async () => {
      await enable();
      await expect(
        rejection(verify(recovery('AAAAA-AAAAA'))),
      ).resolves.toMatchObject({ status: 400 });
      expect(repo.unusedCodes(ALICE)).toHaveLength(10);
    });

    it("declines another user's code and leaves it usable for them", async () => {
      const alice = await enable(ALICE);
      await enable(BOB);

      await expect(
        rejection(verify(recovery(alice.recoveryCodes[0]), plus(MIN), BOB)),
      ).resolves.toMatchObject({ status: 400 });

      expect(repo.unusedCodes(ALICE)).toHaveLength(10);
      expect(repo.unusedCodes(BOB)).toHaveLength(10);
      await expect(
        verify(recovery(alice.recoveryCodes[0])),
      ).resolves.toMatchObject({ verified: true });
    });

    it('audits the use without the code', async () => {
      const { recoveryCodes } = await enable();
      await verify(recovery(recoveryCodes[0]));

      expect(repo.audits.at(-1)).toEqual({
        authId: ALICE,
        changes: [
          {
            fieldName: 'mfaRecoveryCodesRemaining',
            oldValue: '10',
            newValue: '9',
          },
        ],
        metadata: { ...META, actionedBy: ALICE },
      });
      expect(JSON.stringify(repo.audits)).not.toContain(recoveryCodes[0]);
    });
  });

  describe('with an authenticator code', () => {
    it('verifies the current code and records its step', async () => {
      const { secret } = await enable();
      const now = plus(MIN);

      await expect(verify(totp(totpCode(secret, now)), now)).resolves.toEqual({
        verified: true,
        method: 'totp',
        recoveryCodesRemaining: 10,
      });
      expect(repo.accounts.get(ALICE)!.mfaLastUsedStep).toBe(totpStep(now));
    });

    it('declines the code that enabled MFA (already used)', async () => {
      const { secret } = await enable();
      await expect(
        rejection(verify(totp(totpCode(secret, T0)), plus(10_000))),
      ).resolves.toMatchObject({ status: 400 });
    });

    it('declines a code used once already, and an expired one', async () => {
      const { secret } = await enable();
      const now = plus(MIN);
      const code = totpCode(secret, now);
      await verify(totp(code), now);

      await expect(
        rejection(verify(totp(code), plus(MIN + 5_000))),
      ).resolves.toMatchObject({ status: 400 });
      await expect(
        rejection(verify(totp(code), plus(MIN + 30_000))),
      ).resolves.toMatchObject({ status: 400 });
    });
  });

  describe('lockout', () => {
    it('blocks verification for 15 minutes after five incorrect codes', async () => {
      const { recoveryCodes } = await enable();
      const results: { status: number; message: string }[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(
          await rejection(
            verify(recovery('AAAAA-AAAAA'), plus(MIN + i * 1000)),
          ),
        );
      }

      expect(results.map((r) => r.status)).toEqual([400, 400, 400, 400, 429]);
      const until = plus(MIN + 4000 + 15 * MIN);
      expect(results[4].message).toBe(
        `Too many incorrect codes. MFA verification is blocked until ${until.toISOString()}.`,
      );
      // A valid code is declined while blocked, and is not consumed.
      await expect(
        rejection(verify(recovery(recoveryCodes[0]), plus(10 * MIN))),
      ).resolves.toMatchObject({ status: 429 });
      expect(repo.unusedCodes(ALICE)).toHaveLength(10);
      // After the block it works.
      await expect(
        verify(recovery(recoveryCodes[0]), until),
      ).resolves.toMatchObject({ verified: true });
    });

    it('clears the failure history after a successful verification', async () => {
      const { recoveryCodes } = await enable();
      for (let i = 0; i < 4; i++) {
        await rejection(verify(recovery('AAAAA-AAAAA')));
      }
      await verify(recovery(recoveryCodes[0]));

      expect(repo.accounts.get(ALICE)!.mfaFailedAttemptsAt).toEqual([]);
      await expect(
        rejection(verify(recovery('AAAAA-AAAAA'))),
      ).resolves.toMatchObject({
        message: 'Invalid MFA code. 4 attempt(s) remaining.',
      });
    });
  });

  describe('regeneration (the route requires a step-up approval)', () => {
    it('replaces all codes; previous codes stop working', async () => {
      const { recoveryCodes: old } = await enable();
      await verify(recovery(old[0]));

      const view = await service.regenerateRecoveryCodes(ALICE, {
        metadata: META,
      });

      expect(view.recoveryCodes).toHaveLength(10);
      expect(view.recoveryCodesRemaining).toBe(10);
      expect(view.recoveryCodes.some((code) => old.includes(code))).toBe(false);
      await expect(
        hashesMatchCodes(
          ALICE,
          view.recoveryCodes,
          repo.recoveryCodes.get(ALICE)!.map((c) => c.codeHash),
        ),
      ).resolves.toBe(true);
      // Previously unused codes are declined like any invalid code.
      for (const code of old.slice(1, 4)) {
        await expect(
          rejection(verify(recovery(code), plus(3 * MIN))),
        ).resolves.toMatchObject({ status: 400 });
      }
      expect(repo.unusedCodes(ALICE)).toHaveLength(10);
      await expect(
        verify(recovery(view.recoveryCodes[0]), plus(3 * MIN)),
      ).resolves.toMatchObject({ verified: true, recoveryCodesRemaining: 9 });
      // The regeneration is audited as a count (9 left -> 10 new).
      expect(repo.audits.map((a) => a.changes[0])).toContainEqual({
        fieldName: 'mfaRecoveryCodesRemaining',
        oldValue: '9',
        newValue: '10',
      });
    });

    it('is refused while MFA is not enabled, and creates nothing', async () => {
      await expect(
        rejection(service.regenerateRecoveryCodes(ALICE, { metadata: META })),
      ).resolves.toEqual({
        status: 409,
        message: 'MFA is not enabled for this account',
      });
      expect(repo.recoveryCodes.get(ALICE) ?? []).toEqual([]);
    });
  });

  it('refuses verification while MFA is not enabled, without counting', async () => {
    await expect(rejection(verify(recovery('AAAAA-AAAAA')))).resolves.toEqual({
      status: 409,
      message: 'MFA is not enabled for this account',
    });
    expect(repo.accounts.get(ALICE)!.mfaFailedAttemptsAt).toEqual([]);
  });

  it('answers 503 when the stored secret cannot be decrypted', async () => {
    await enable();
    repo.accounts.get(ALICE)!.mfaSecret = 'v1.AAAA.AAAA.AAAA';

    await expect(rejection(verify(totp('123456')))).resolves.toMatchObject({
      status: 503,
    });
    expect(repo.accounts.get(ALICE)!.mfaFailedAttemptsAt).toEqual([]);
  });

  it('never logs a code', async () => {
    const { recoveryCodes, secret } = await enable();
    await verify(recovery(recoveryCodes[0]));
    await rejection(verify(recovery(recoveryCodes[0])));
    const now = plus(2 * MIN);
    const code = totpCode(secret, now);
    await verify(totp(code), now);
    const { recoveryCodes: fresh } = await service.regenerateRecoveryCodes(
      ALICE,
      { metadata: META },
    );

    const logged = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    for (const secretValue of [...recoveryCodes, ...fresh, code, secret]) {
      expect(logged).not.toContain(secretValue);
      expect(logged).not.toContain(secretValue.replace('-', ''));
    }
  });
});
