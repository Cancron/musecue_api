import { HttpException } from '@nestjs/common';
import { mock } from 'jest-mock-extended';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import { FakeMfaNotifier } from '../../../test/support/fake-mfa-notifier';
import { FakeMfaRepository } from '../../../test/support/fake-mfa-repository';
import { testCipher } from '../../../test/support/mfa-test-keys';
import config from '../../common/config/app.config';
import { totpCode } from './mfa-totp';
import {
  MfaVerificationService,
  type MfaFactor,
} from './mfa-verification.service';
import { MfaService } from './mfa.service';

// Recovery codes use salted scrypt (deliberately slow).
jest.setTimeout(30_000);

const ALICE = 'alice';
const BOB = 'bob';
const META = { ip: '203.0.113.9', userAgent: 'jest' };
const CHANGE = { metadata: META, approvedWith: 'TOTP' as const };
/** The start of a 30-second TOTP step. */
const T0 = new Date(Math.floor(Date.UTC(2026, 10, 26, 9) / 30_000) * 30_000);
const plus = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const STEP = 30_000;

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), message: error.message };
  }
  throw new Error('Expected the call to be rejected');
}

describe('MFA management (disable, replace the authenticator)', () => {
  const originalSecret = config.jwt_refresh_secret;
  let repo: FakeMfaRepository;
  let notifier: FakeMfaNotifier;
  let logger: ReturnType<typeof mock<Logger>>;
  let service: MfaService;
  let verification: MfaVerificationService;

  beforeAll(() => {
    config.jwt_refresh_secret = ''; // MFA never needs it
  });
  afterAll(() => {
    config.jwt_refresh_secret = originalSecret;
  });

  beforeEach(() => {
    repo = new FakeMfaRepository();
    repo.addAccount(ALICE);
    repo.addAccount(BOB);
    notifier = new FakeMfaNotifier();
    logger = mock<Logger>();
    const cipher = testCipher();
    service = new MfaService(
      repo.asRepository(),
      cipher,
      notifier.asNotifier(),
      logger,
    );
    verification = new MfaVerificationService(
      repo.asRepository(),
      cipher,
      notifier.asNotifier(),
      logger,
    );
  });

  /** Enables MFA at T0 (and trusts two devices of the user). */
  async function enable(authId = ALICE) {
    const { secret } = await service.startEnrollment(authId, T0);
    const { recoveryCodes } = await service.confirmEnrollment(
      authId,
      totpCode(secret, T0),
      META,
      T0,
    );
    for (const name of ['phone', 'laptop']) {
      repo.devices.push({
        id: randomUUID(),
        authId,
        tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        name,
        ipAddress: null,
        userAgent: null,
        createdAt: T0,
        expiresAt: plus(30 * 24 * 60 * MIN),
        lastUsedAt: null,
        revokedAt: null,
      });
    }
    return { secret, recoveryCodes };
  }

  const verify = (factor: MfaFactor, now: Date, authId = ALICE) =>
    verification.verify(authId, factor, META, now);
  const activeDevices = (authId: string) =>
    repo.devices.filter((d) => d.authId === authId && !d.revokedAt);

  describe('disabling MFA', () => {
    it('turns MFA off and invalidates the secret, recovery codes and trusted devices', async () => {
      const { secret, recoveryCodes } = await enable();
      await enable(BOB);

      const view = await service.disable(ALICE, CHANGE, plus(MIN));

      expect(view).toMatchObject({
        enabled: false,
        method: null,
        recoveryCodesRemaining: null,
        trustedDevicesRevoked: 2,
      });
      expect(repo.accounts.get(ALICE)).toMatchObject({
        mfaEnabled: false,
        mfaMethod: null,
        mfaSecret: null,
        mfaLastUsedStep: null,
      });
      expect(repo.recoveryCodes.get(ALICE)).toEqual([]);
      expect(activeDevices(ALICE)).toEqual([]);
      // Old credentials are refused: MFA is off.
      await expect(
        rejection(
          verify(
            { method: 'totp', code: totpCode(secret, plus(2 * MIN)) },
            plus(2 * MIN),
          ),
        ),
      ).resolves.toMatchObject({ status: 409 });
      await expect(
        rejection(
          verify(
            { method: 'recovery_code', code: recoveryCodes[0] },
            plus(2 * MIN),
          ),
        ),
      ).resolves.toMatchObject({ status: 409 });
      // Bob is untouched.
      expect(repo.accounts.get(BOB)!.mfaEnabled).toBe(true);
      expect(activeDevices(BOB)).toHaveLength(2);
    });

    it('records the change without secrets, and notifies after the commit', async () => {
      const { secret, recoveryCodes } = await enable();

      await service.disable(ALICE, CHANGE, plus(MIN));

      const audit = repo.audits.at(-1)!;
      expect(audit.changes).toEqual([
        { fieldName: 'mfaEnabled', oldValue: 'true', newValue: 'false' },
        { fieldName: 'mfaMethod', oldValue: 'totp', newValue: null },
        {
          fieldName: 'mfaRecoveryCodesRemaining',
          oldValue: '10',
          newValue: '0',
        },
        {
          fieldName: 'mfaTrustedDevicesRevoked',
          oldValue: null,
          newValue: '2',
        },
        { fieldName: 'stepUpMethod', oldValue: null, newValue: 'TOTP' },
      ]);
      expect(audit.metadata).toEqual({ ...META, actionedBy: ALICE });
      expect(notifier.events()).toEqual(['MFA_DISABLED']);
      const recorded = JSON.stringify([repo.audits, notifier.recorded]);
      for (const value of [secret, ...recoveryCodes]) {
        expect(recorded).not.toContain(value);
      }
    });

    it('is refused (409) when MFA is off, changing nothing', async () => {
      await expect(
        rejection(service.disable(ALICE, CHANGE, T0)),
      ).resolves.toEqual({
        status: 409,
        message: 'MFA is not enabled for this account',
      });
      expect(notifier.dispatched).toEqual([]);
      expect(repo.audits).toEqual([]);
    });

    it('leaves nothing changed (and sends nothing) when it fails midway', async () => {
      await enable();
      const before = {
        account: { ...repo.accounts.get(ALICE)! },
        codes: repo.recoveryCodes.get(ALICE)!.length,
      };
      notifier.record = () => Promise.reject(new Error('database down'));

      await expect(
        rejection(service.disable(ALICE, CHANGE, plus(MIN))),
      ).resolves.toMatchObject({
        status: 503,
      });

      expect(repo.accounts.get(ALICE)).toEqual(before.account);
      expect(repo.recoveryCodes.get(ALICE)).toHaveLength(before.codes);
      expect(activeDevices(ALICE)).toHaveLength(2);
      expect(notifier.dispatched).toEqual([]);
    });

    it('lets the user enroll again afterwards, with a new secret', async () => {
      const { secret } = await enable();
      await service.disable(ALICE, CHANGE, plus(MIN));

      const again = await service.startEnrollment(ALICE, plus(2 * MIN));
      expect(again.secret).not.toBe(secret);
    });
  });

  describe('replacing the authenticator', () => {
    it('switches to the new app: old codes stop working, recovery codes keep working', async () => {
      const { secret: oldSecret, recoveryCodes } = await enable();
      const started = await service.startReplacement(ALICE, plus(MIN));
      expect(started.secret).not.toBe(oldSecret);
      // Until confirmed, the old app still works.
      await expect(
        verify(
          { method: 'totp', code: totpCode(oldSecret, plus(MIN)) },
          plus(MIN),
        ),
      ).resolves.toMatchObject({ verified: true });

      const confirmAt = plus(MIN + STEP);
      const view = await service.confirmReplacement(
        ALICE,
        totpCode(started.secret, confirmAt),
        CHANGE,
        confirmAt,
      );

      expect(view).toMatchObject({
        enabled: true,
        method: 'totp',
        recoveryCodesRemaining: 10,
        trustedDevicesRevoked: 2,
        enrollment: { status: 'NONE' },
      });
      expect(activeDevices(ALICE)).toEqual([]);
      const later = plus(MIN + 2 * STEP);
      await expect(
        rejection(
          verify({ method: 'totp', code: totpCode(oldSecret, later) }, later),
        ),
      ).resolves.toMatchObject({ status: 400 });
      const laterStill = plus(MIN + 3 * STEP);
      await expect(
        verify(
          { method: 'totp', code: totpCode(started.secret, laterStill) },
          laterStill,
        ),
      ).resolves.toMatchObject({ verified: true });
      await expect(
        verify({ method: 'recovery_code', code: recoveryCodes[0] }, laterStill),
      ).resolves.toMatchObject({ verified: true });
    });

    it('never accepts a code of the old app as confirmation', async () => {
      const { secret: oldSecret } = await enable();
      await service.startReplacement(ALICE, plus(MIN));
      const at = plus(MIN + STEP);

      await expect(
        rejection(
          service.confirmReplacement(
            ALICE,
            totpCode(oldSecret, at),
            CHANGE,
            at,
          ),
        ),
      ).resolves.toMatchObject({ status: 400 });
      expect(repo.accounts.get(ALICE)!.mfaEnabled).toBe(true);
      expect(activeDevices(ALICE)).toHaveLength(2);
      expect(notifier.dispatched).toEqual([]);
    });

    it('records the change without secrets, and notifies', async () => {
      const { secret: oldSecret } = await enable();
      const started = await service.startReplacement(ALICE, plus(MIN));
      const at = plus(MIN + STEP);

      await service.confirmReplacement(
        ALICE,
        totpCode(started.secret, at),
        CHANGE,
        at,
      );

      expect(repo.audits.at(-1)!.changes).toEqual([
        { fieldName: 'mfaAuthenticator', oldValue: null, newValue: 'replaced' },
        {
          fieldName: 'mfaTrustedDevicesRevoked',
          oldValue: null,
          newValue: '2',
        },
        { fieldName: 'stepUpMethod', oldValue: null, newValue: 'TOTP' },
      ]);
      expect(notifier.events()).toEqual(['MFA_AUTHENTICATOR_REPLACED']);
      const recorded = JSON.stringify([repo.audits, notifier.recorded]);
      for (const value of [oldSecret, started.secret]) {
        expect(recorded).not.toContain(value);
      }
    });

    it('expires after 10 minutes and is refused without MFA', async () => {
      await enable();
      const started = await service.startReplacement(ALICE, plus(MIN));
      const late = plus(11 * MIN);
      await expect(
        rejection(
          service.confirmReplacement(
            ALICE,
            totpCode(started.secret, late),
            CHANGE,
            late,
          ),
        ),
      ).resolves.toEqual({
        status: 410,
        message: 'The authenticator replacement has expired. Start a new one.',
      });

      await expect(
        rejection(service.startReplacement(BOB, T0)),
      ).resolves.toMatchObject({
        status: 409,
      });
      await expect(
        rejection(service.confirmReplacement(BOB, '123456', CHANGE, T0)),
      ).resolves.toMatchObject({ status: 409 });
    });

    it('shares the 5-in-15-minutes lockout of enrollment', async () => {
      await enable();
      const started = await service.startReplacement(ALICE, plus(MIN));
      const code = totpCode(started.secret, plus(MIN));
      const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push(
          (
            await rejection(
              service.confirmReplacement(ALICE, wrong, CHANGE, plus(MIN)),
            )
          ).status,
        );
      }
      expect(statuses).toEqual([400, 400, 400, 400, 429]);
      expect(
        (await service.getStatus(ALICE, plus(2 * MIN))).enrollment.status,
      ).toBe('BLOCKED');
    });

    it('is shown in the status while pending', async () => {
      await enable();
      const started = await service.startReplacement(ALICE, plus(MIN));
      expect(
        (await service.getStatus(ALICE, plus(2 * MIN))).enrollment,
      ).toMatchObject({
        status: 'PENDING',
        expiresAt: started.expiresAt,
      });
    });
  });

  describe('regenerating recovery codes', () => {
    it('notifies after the commit, without the codes', async () => {
      await enable();
      const view = await verification.regenerateRecoveryCodes(
        ALICE,
        CHANGE,
        plus(MIN),
      );

      expect(notifier.events()).toEqual(['MFA_RECOVERY_CODES_REGENERATED']);
      expect(repo.audits.at(-1)!.changes).toContainEqual({
        fieldName: 'stepUpMethod',
        oldValue: null,
        newValue: 'TOTP',
      });
      const recorded = JSON.stringify([repo.audits, notifier.recorded]);
      for (const code of view.recoveryCodes)
        expect(recorded).not.toContain(code);
    });
  });
});
