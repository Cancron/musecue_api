import { Inject, Injectable } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import AppError from '../../common/errors/app.error';
import { SecretDecryptionError } from '../../common/security/derived-secrets';
import {
  ActivityLogService,
  type ActivityLogMetadata,
} from '../../common/services/activity-log.service';
import { MFA_VERIFICATION } from './mfa.constants';
import {
  MfaCredentialsRepository,
  type LockedMfaCredentials,
} from './mfa-credentials.repository';
import {
  isBlocked,
  NO_FAILURES,
  registerFailure,
} from './mfa-enrollment.policy';
import { MfaEncryptionUnavailableError } from './mfa-keys';
import { MfaRecoveryCodeHasher } from './mfa-recovery-code.hasher';
import { MfaSecretCipher } from './mfa-secret.cipher';
import type {
  MfaRecoveryCodesView,
  MfaVerificationMethod,
  MfaVerificationView,
} from './mfa.interface';
import { verifyTotp } from './totp';

/** The second factor presented: the authenticator's code or a recovery code. */
export type MfaFactor = { code: string } | { recoveryCode: string };

type Refusal =
  | { kind: 'NOT_ENABLED' }
  | { kind: 'BLOCKED'; until: Date }
  | { kind: 'INVALID_CODE' };

type Outcome<T> = { ok: true; value: T } | ({ ok: false } & Refusal);

/** A stored secret that cannot be decrypted (the MFA key changed). */
class MfaSecretUnreadableError extends Error {}

const refuse = (refusal: Refusal): { ok: false } & Refusal => ({
  ok: false,
  ...refusal,
});

/**
 * Verifies the second factor of the signed-in user's own account: the
 * authenticator's current code or one of the account's recovery codes, each
 * usable once. Also regenerates the recovery codes (after such a
 * verification), which invalidates every earlier code.
 *
 * Invalid, expired, already used, replaced and other accounts' codes are all
 * refused with the same answer and counted; the 5th incorrect code within 15
 * minutes blocks verification for 15 minutes. Codes are never logged or
 * returned again after the response that issued them.
 */
@Injectable()
export class MfaVerificationService {
  constructor(
    private readonly credentials: MfaCredentialsRepository,
    private readonly cipher: MfaSecretCipher,
    private readonly recoveryCodes: MfaRecoveryCodeHasher,
    private readonly activityLog: ActivityLogService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async verify(
    authId: string,
    factor: MfaFactor,
    meta: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<MfaVerificationView> {
    const outcome = await this.locked(authId, async (locked) => {
      const verified = await this.checkFactor(locked, factor, now, meta);
      if (!verified.ok) return verified;
      const { remaining } = await locked.recoverySummary();
      return {
        ok: true as const,
        value: {
          verified: true as const,
          method: verified.value,
          remainingRecoveryCodes: remaining,
        },
      };
    });
    if (!outcome.ok) throw this.refusalError(outcome, now);
    return outcome.value;
  }

  /**
   * Replaces the recovery codes with a new set of 10, after verifying the
   * account's second factor (a recovery code used for this is consumed). The
   * new codes are returned only in this response; every earlier code stops
   * working in the same transaction.
   */
  async regenerateRecoveryCodes(
    authId: string,
    factor: MfaFactor,
    meta: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<MfaRecoveryCodesView> {
    const outcome = await this.locked(authId, async (locked) => {
      const verified = await this.checkFactor(locked, factor, now, meta);
      if (!verified.ok) return verified;
      const before = await locked.recoverySummary();
      const issued = this.recoveryCodes.issue(authId);
      await locked.replaceRecoveryCodes(issued.hashes, now);
      await this.audit(locked, meta, before.remaining, issued.codes.length);
      return {
        ok: true as const,
        value: {
          recoveryCodes: issued.codes,
          generatedAt: now,
          remainingRecoveryCodes: issued.codes.length,
          verifiedWith: verified.value,
        },
      };
    });
    if (!outcome.ok) throw this.refusalError(outcome, now);
    this.logger.info('MFA recovery codes regenerated', {
      context: 'MfaVerificationService',
      userId: authId,
    });
    return outcome.value;
  }

  /**
   * Checks and consumes the factor (a TOTP step or a recovery code), counting
   * a failure or resetting the counter, inside the locked transaction.
   */
  private async checkFactor(
    locked: LockedMfaCredentials,
    factor: MfaFactor,
    now: Date,
    meta: ActivityLogMetadata,
  ): Promise<Outcome<MfaVerificationMethod>> {
    const { credentials } = locked;
    if (!credentials.mfaEnabled) return refuse({ kind: 'NOT_ENABLED' });
    if (isBlocked(credentials.counter, now)) {
      return refuse({
        kind: 'BLOCKED',
        until: credentials.counter.blockedUntil as Date,
      });
    }

    const method =
      'recoveryCode' in factor
        ? await this.useRecoveryCode(locked, factor.recoveryCode, now, meta)
        : await this.useTotp(locked, factor.code, now);

    if (method === null) {
      const { counter, blocked } = registerFailure(
        credentials.counter,
        now,
        MFA_VERIFICATION,
      );
      await locked.saveCounter(counter);
      if (!blocked) return refuse({ kind: 'INVALID_CODE' });
      this.logger.warn(
        'MFA verification blocked after repeated incorrect codes',
        {
          context: 'MfaVerificationService',
          userId: credentials.authId,
          blockedUntil: counter.blockedUntil?.toISOString(),
        },
      );
      return refuse({ kind: 'BLOCKED', until: counter.blockedUntil as Date });
    }

    if (
      credentials.counter.failedAttempts !== 0 ||
      credentials.counter.failureWindowStartedAt !== null ||
      credentials.counter.blockedUntil !== null
    ) {
      await locked.saveCounter({ ...NO_FAILURES });
    }
    return { ok: true, value: method };
  }

  private async useTotp(
    locked: LockedMfaCredentials,
    code: string,
    now: Date,
  ): Promise<MfaVerificationMethod | null> {
    const { authId, encryptedSecret, lastUsedStep } = locked.credentials;
    if (encryptedSecret === null) return null;
    let secret: string;
    try {
      secret = this.cipher.decrypt(authId, 'active', encryptedSecret);
    } catch (error) {
      if (error instanceof SecretDecryptionError) {
        throw new MfaSecretUnreadableError();
      }
      throw error;
    }
    // Codes of the step already used (e.g. the one that enabled MFA) or of
    // an earlier step are refused.
    const step = verifyTotp(secret, code, now, { lastUsedStep });
    if (step === null) return null;
    return (await locked.acceptTotpStep(step)) ? 'totp' : null;
  }

  private async useRecoveryCode(
    locked: LockedMfaCredentials,
    recoveryCode: string,
    now: Date,
    meta: ActivityLogMetadata,
  ): Promise<MfaVerificationMethod | null> {
    const { authId } = locked.credentials;
    // The hash is bound to this user: another account's code never matches.
    const codeHash = this.recoveryCodes.hash(authId, recoveryCode);
    if (codeHash === null) return null;
    if (!(await locked.consumeRecoveryCode(codeHash, now))) return null;
    const { remaining } = await locked.recoverySummary();
    await this.audit(locked, meta, remaining + 1, remaining);
    this.logger.info('MFA recovery code used', {
      context: 'MfaVerificationService',
      userId: authId,
      remainingRecoveryCodes: remaining,
    });
    return 'recovery_code';
  }

  /** Audits a change of the number of usable codes (never a code). */
  private async audit(
    locked: LockedMfaCredentials,
    meta: ActivityLogMetadata,
    before: number,
    after: number,
  ): Promise<void> {
    const { authId } = locked.credentials;
    await this.activityLog.logActivity(
      {
        tableName: 'authUser',
        recordId: authId,
        action: 'update',
        eventType: 'update',
        changes: [
          {
            fieldName: 'mfaRecoveryCodesRemaining',
            oldValue: String(before),
            newValue: String(after),
          },
        ],
        metadata: { ...meta, actionedBy: authId },
      },
      locked.tx,
    );
  }

  private async locked<T>(
    authId: string,
    work: (locked: LockedMfaCredentials) => Promise<Outcome<T>>,
  ): Promise<Outcome<T>> {
    let found: { result: Outcome<T> } | null;
    try {
      found = await this.credentials.withLockedCredentials(
        authId,
        async (locked) => {
          if (locked.credentials.status !== 'ACTIVE') {
            throw AppError.unauthorized('User account is not active');
          }
          return work(locked);
        },
      );
    } catch (error) {
      if (
        error instanceof MfaEncryptionUnavailableError ||
        error instanceof MfaSecretUnreadableError
      ) {
        this.logger.error(
          error instanceof MfaSecretUnreadableError
            ? 'Stored MFA secret cannot be decrypted (was the MFA key changed?)'
            : 'MFA secret encryption is not configured',
          { context: 'MfaVerificationService', userId: authId },
        );
        throw AppError.serviceUnavailable('MFA is temporarily unavailable');
      }
      throw error;
    }
    if (!found) throw AppError.unauthorized('User not found');
    return found.result;
  }

  private refusalError(refusal: Refusal, now: Date): AppError {
    switch (refusal.kind) {
      case 'NOT_ENABLED':
        return AppError.conflict('MFA is not enabled for this account');
      case 'BLOCKED': {
        const minutes = Math.max(
          1,
          Math.ceil((refusal.until.getTime() - now.getTime()) / 60_000),
        );
        return AppError.tooManyRequests(
          `Too many incorrect authentication codes. MFA verification is blocked; try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        );
      }
      case 'INVALID_CODE':
        return AppError.badRequest('Invalid or expired authentication code');
    }
  }
}
