import { Inject, Injectable } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import AppError from '../../common/errors/app.error';
import type { ActivityLogMetadata } from '../../common/services/activity-log.service';
import {
  guardMfaStorage,
  mfaBlockedError,
  requireActiveAccount,
} from './mfa-errors';
import { activeBlock, registerFailure } from './mfa-lockout.policy';
import {
  hashRecoveryCode,
  issueRecoveryCodes,
  normalizeRecoveryCode,
} from './mfa-recovery-codes';
import { decryptMfaSecret } from './mfa-secret.cipher';
import { verifyTotp } from './mfa-totp';
import { MFA_AUDIT_FIELDS } from './mfa.constants';
import {
  MfaRepository,
  type MfaUnitOfWork,
  type MfaVerificationState,
} from './mfa.repository';

/** A second factor: the authenticator app's code or a recovery code. */
export type MfaFactor =
  | { method: 'totp'; code: string }
  | { method: 'recovery_code'; code: string };

export type MfaMethodUsed = MfaFactor['method'];

export interface MfaVerificationView {
  verified: true;
  method: MfaMethodUsed;
  /** Unused recovery codes left (never the codes themselves). */
  recoveryCodesRemaining: number;
}

/** Returned once, on regeneration; the codes are never shown again. */
export interface MfaRecoveryCodesView {
  recoveryCodes: string[];
  recoveryCodesRemaining: number;
}

type CheckOutcome =
  | { kind: 'VERIFIED'; method: MfaMethodUsed }
  | { kind: 'NOT_ENABLED' }
  | { kind: 'BLOCKED'; until: Date }
  | { kind: 'INVALID'; remainingAttempts: number }
  | { kind: 'BLOCKED_NOW'; until: Date };

const CONTEXT = 'MfaVerificationService';

/**
 * MFA verification of the signed-in owner with either the authenticator
 * app's current code or one of the single-use recovery codes, and
 * regeneration of the recovery codes (which itself requires a second
 * factor).
 *
 * - An authenticator code is accepted only within its 30-second step and
 *   only once (its step is recorded).
 * - A recovery code is accepted once: it is consumed by one conditional
 *   UPDATE of its row, so of concurrent requests with the same code exactly
 *   one succeeds. Using one code never affects the others.
 * - Wrong, expired, already used, replaced and other users' codes are all
 *   declined alike (400) and counted: five within 15 minutes block
 *   verification for 15 minutes.
 *
 * Codes and secrets are never logged or returned, except the new recovery
 * codes in the single response that issues them.
 */
@Injectable()
export class MfaVerificationService {
  constructor(
    private readonly repository: MfaRepository,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async verify(
    authId: string,
    factor: MfaFactor,
    metadata: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<MfaVerificationView> {
    const result = await this.guard(() =>
      this.repository.withLock(authId, async (uow) => {
        const outcome = await this.checkFactor(
          uow,
          authId,
          factor,
          metadata,
          now,
        );
        const recoveryCodesRemaining =
          outcome.kind === 'VERIFIED' ? await uow.countRecoveryCodes() : 0;
        return { outcome, recoveryCodesRemaining };
      }),
    );
    const { outcome } = result;
    if (outcome.kind !== 'VERIFIED') throw this.declined(authId, outcome);
    this.logger.info('MFA verified', {
      context: CONTEXT,
      authId,
      method: outcome.method,
    });
    return {
      verified: true,
      method: outcome.method,
      recoveryCodesRemaining: result.recoveryCodesRemaining,
    };
  }

  /**
   * Proves a second factor, then replaces every recovery code of the user
   * (used or not) with ten new ones, in one transaction. A recovery code
   * used as the proof is consumed like any other use.
   */
  async regenerateRecoveryCodes(
    authId: string,
    factor: MfaFactor,
    metadata: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<MfaRecoveryCodesView> {
    const result = await this.guard(() =>
      this.repository.withLock(authId, async (uow) => {
        const outcome = await this.checkFactor(
          uow,
          authId,
          factor,
          metadata,
          now,
        );
        if (outcome.kind !== 'VERIFIED') {
          return { outcome, recoveryCodes: [] as string[] };
        }
        const previous = await uow.countRecoveryCodes();
        const recoveryCodes = await issueRecoveryCodes(uow, authId);
        await uow.audit(
          [
            {
              fieldName: MFA_AUDIT_FIELDS.RECOVERY_CODES_REMAINING,
              oldValue: String(previous),
              newValue: String(recoveryCodes.length),
            },
          ],
          { ...metadata, actionedBy: authId },
        );
        return { outcome, recoveryCodes };
      }),
    );
    const { outcome } = result;
    if (outcome.kind !== 'VERIFIED') throw this.declined(authId, outcome);
    this.logger.info('MFA recovery codes regenerated', {
      context: CONTEXT,
      authId,
      method: outcome.method,
    });
    return {
      recoveryCodes: result.recoveryCodes,
      recoveryCodesRemaining: result.recoveryCodes.length,
    };
  }

  /**
   * Checks the factor under the user's lock. Outcomes are returned (not
   * thrown) so a counted failure commits.
   */
  private async checkFactor(
    uow: MfaUnitOfWork,
    authId: string,
    factor: MfaFactor,
    metadata: ActivityLogMetadata,
    now: Date,
  ): Promise<CheckOutcome> {
    const account = requireActiveAccount(await uow.account());
    const state = account.mfaEnabled ? await uow.verificationState() : null;
    if (!state) return { kind: 'NOT_ENABLED' };

    const blockedUntil = activeBlock(state.blockedUntil, now);
    if (blockedUntil) return { kind: 'BLOCKED', until: blockedUntil };

    const accepted =
      factor.method === 'totp'
        ? await this.acceptTotp(uow, authId, state, factor.code, now)
        : await this.acceptRecoveryCode(uow, authId, factor.code, now, {
            ...metadata,
            actionedBy: authId,
          });

    if (!accepted) {
      const failure = registerFailure(state.failedAttemptsAt, now);
      await uow.saveVerificationLockout({
        failedAttemptsAt: failure.failedAttemptsAt,
        blockedUntil: failure.blockedUntil,
      });
      return failure.blockedUntil
        ? { kind: 'BLOCKED_NOW', until: failure.blockedUntil }
        : { kind: 'INVALID', remainingAttempts: failure.remainingAttempts };
    }

    if (state.failedAttemptsAt.length > 0 || state.blockedUntil) {
      await uow.saveVerificationLockout({
        failedAttemptsAt: [],
        blockedUntil: null,
      });
    }
    return { kind: 'VERIFIED', method: factor.method };
  }

  private async acceptTotp(
    uow: MfaUnitOfWork,
    authId: string,
    state: MfaVerificationState,
    code: string,
    now: Date,
  ): Promise<boolean> {
    if (!state.mfaSecret) {
      throw new Error('MFA is enabled without a stored secret');
    }
    // A secret that cannot be decrypted (e.g. the key changed) throws and
    // becomes a 503: it is not the user's mistake.
    const secret = decryptMfaSecret('confirmed', authId, state.mfaSecret);
    const check = verifyTotp(secret, code, now, state.mfaLastUsedStep);
    if (check.result !== 'VALID') return false;
    return uow.recordTotpStep(check.step);
  }

  private async acceptRecoveryCode(
    uow: MfaUnitOfWork,
    authId: string,
    code: string,
    now: Date,
    metadata: ActivityLogMetadata,
  ): Promise<boolean> {
    if (!normalizeRecoveryCode(code)) return false;
    const consumed = await uow.consumeRecoveryCode(
      hashRecoveryCode(authId, code),
      now,
    );
    if (!consumed) return false;
    const remaining = await uow.countRecoveryCodes();
    await uow.audit(
      [
        {
          fieldName: MFA_AUDIT_FIELDS.RECOVERY_CODES_REMAINING,
          oldValue: String(remaining + 1),
          newValue: String(remaining),
        },
      ],
      metadata,
    );
    return true;
  }

  private declined(
    authId: string,
    outcome: Exclude<CheckOutcome, { kind: 'VERIFIED' }>,
  ): AppError {
    switch (outcome.kind) {
      case 'NOT_ENABLED':
        return AppError.conflict('MFA is not enabled for this account');
      case 'BLOCKED':
        return mfaBlockedError('MFA verification', outcome.until);
      case 'BLOCKED_NOW':
        this.logger.warn('MFA verification blocked after incorrect codes', {
          context: CONTEXT,
          authId,
        });
        return mfaBlockedError('MFA verification', outcome.until);
      case 'INVALID':
        this.logger.warn('Incorrect MFA verification code', {
          context: CONTEXT,
          authId,
          remainingAttempts: outcome.remainingAttempts,
        });
        return AppError.badRequest(
          `Invalid MFA code. ${outcome.remainingAttempts} attempt(s) remaining.`,
        );
    }
  }

  private guard<T>(operation: () => Promise<T>): Promise<T> {
    return guardMfaStorage(this.logger, CONTEXT, operation);
  }
}
