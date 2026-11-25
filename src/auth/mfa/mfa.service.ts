import { Inject, Injectable } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import AppError from '../../common/errors/app.error';
import { SecretDecryptionError } from '../../common/security/derived-secrets';
import {
  ActivityLogService,
  type ActivityLogMetadata,
} from '../../common/services/activity-log.service';
import { MFA_TOTP, MFA_VERIFICATION } from './mfa.constants';
import {
  MfaCredentialsRepository,
  type RecoveryCodeSummary,
} from './mfa-credentials.repository';
import {
  enrollmentStatus,
  type FailureCounter,
  isBlocked,
  isExpired,
  recordFailure,
  remainingAttempts,
  startedEnrollment,
} from './mfa-enrollment.policy';
import {
  EMPTY_ENROLLMENT,
  MfaEnrollmentRepository,
  type LockedMfaAccount,
  type MfaAccount,
  type MfaEnrollmentState,
} from './mfa-enrollment.repository';
import { MfaRecoveryCodeHasher } from './mfa-recovery-code.hasher';
import {
  MfaEncryptionUnavailableError,
  MfaSecretCipher,
} from './mfa-secret.cipher';
import type {
  MfaActivationView,
  MfaEnrollmentView,
  MfaStatusView,
} from './mfa.interface';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp';

/** Outcomes decided inside the locked transaction, turned into HTTP errors after it commits. */
type Refusal =
  | { kind: 'ALREADY_ENABLED' }
  | { kind: 'BLOCKED'; until: Date }
  | { kind: 'NOT_STARTED' }
  | { kind: 'EXPIRED' }
  | { kind: 'INVALID_CODE' };

type Outcome<T> = { ok: true; value: T } | ({ ok: false } & Refusal);

const refuse = (refusal: Refusal): { ok: false } & Refusal => ({
  ok: false,
  ...refusal,
});

/**
 * Optional authenticator-app (TOTP) MFA for the signed-in user's own
 * account: start an enrollment, confirm it with a current code, read the
 * status. The account is always the caller's (`authId` comes from the access
 * token); no request can name another account.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly enrollments: MfaEnrollmentRepository,
    private readonly credentials: MfaCredentialsRepository,
    private readonly cipher: MfaSecretCipher,
    private readonly recoveryCodes: MfaRecoveryCodeHasher,
    private readonly activityLog: ActivityLogService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async getStatus(
    authId: string,
    now: Date = new Date(),
  ): Promise<MfaStatusView> {
    const state = await this.enrollments.read(authId);
    if (!state) throw this.accountUnavailable();
    this.assertActive(state.account);
    const summary = state.account.mfaEnabled
      ? await this.credentials.summary(authId)
      : null;
    return this.statusView(state.account, state.enrollment, now, summary);
  }

  /**
   * Starts (or restarts) an enrollment with a new secret, pending for 10
   * minutes. A restart replaces the previous secret but never resets the
   * failed-code counter.
   */
  async startEnrollment(
    authId: string,
    now: Date = new Date(),
  ): Promise<MfaEnrollmentView> {
    const secret = generateTotpSecret();
    const outcome = await this.locked(authId, async (locked) => {
      if (locked.account.mfaEnabled) return refuse({ kind: 'ALREADY_ENABLED' });
      if (isBlocked(locked.enrollment, now)) {
        return refuse({
          kind: 'BLOCKED',
          until: locked.enrollment.blockedUntil as Date,
        });
      }
      const next = startedEnrollment(
        locked.enrollment,
        this.encrypt(authId, 'enrollment', secret),
        now,
      );
      await locked.saveEnrollment(next);
      return {
        ok: true as const,
        value: {
          email: locked.account.email,
          expiresAt: next.expiresAt as Date,
        },
      };
    });
    if (!outcome.ok) throw this.refusalError(outcome, now);

    const accountName = outcome.value.email;
    return {
      method: 'totp',
      secret,
      otpauthUrl: otpauthUrl({ secret, accountName }),
      issuer: MFA_TOTP.ISSUER,
      accountName,
      algorithm: MFA_TOTP.ALGORITHM,
      digits: MFA_TOTP.DIGITS,
      period: MFA_TOTP.PERIOD_SECONDS,
      expiresAt: outcome.value.expiresAt,
    };
  }

  /**
   * Confirms the pending enrollment with the authenticator's current code:
   * stores the secret encrypted in authSecurity.mfaSecret, enables MFA and
   * issues the first 10 recovery codes (stored as hashes; returned only in
   * this response). Wrong, expired (earlier time step) and reused codes are
   * refused and counted; the 5th within 15 minutes blocks enrollment.
   */
  async confirmEnrollment(
    authId: string,
    code: string,
    meta: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<MfaActivationView> {
    const outcome = await this.locked(authId, async (locked) => {
      const { account, enrollment } = locked;
      if (account.mfaEnabled) return refuse({ kind: 'ALREADY_ENABLED' });
      if (isBlocked(enrollment, now)) {
        return refuse({
          kind: 'BLOCKED',
          until: enrollment.blockedUntil as Date,
        });
      }
      if (enrollment.secret === null) return refuse({ kind: 'NOT_STARTED' });
      if (isExpired(enrollment, now)) return refuse({ kind: 'EXPIRED' });

      const secret = this.readPendingSecret(authId, enrollment.secret);
      if (secret === null) {
        // Unreadable (the encryption key changed): the enrollment cannot be
        // confirmed any more; the user starts a new one.
        await locked.saveEnrollment({
          ...enrollment,
          secret: null,
          expiresAt: null,
        });
        return refuse({ kind: 'EXPIRED' });
      }

      const step = verifyTotp(secret, code, now);
      if (step === null) return this.countFailure(locked, now);

      const recovery = this.recoveryCodes.issue(authId);
      await locked.activate({
        encryptedSecret: this.encrypt(authId, 'active', secret),
        method: 'totp',
        lastUsedStep: step,
        enabledAt: now,
        recoveryCodeHashes: recovery.hashes,
      });
      await this.activityLog.logActivity(
        {
          tableName: 'authUser',
          recordId: authId,
          action: 'update',
          eventType: 'update',
          changes: [
            { fieldName: 'mfaEnabled', oldValue: 'false', newValue: 'true' },
            { fieldName: 'mfaMethod', oldValue: null, newValue: 'totp' },
            {
              fieldName: 'mfaRecoveryCodesRemaining',
              oldValue: null,
              newValue: String(recovery.codes.length),
            },
          ],
          metadata: { ...meta, actionedBy: authId },
        },
        locked.tx,
      );
      return {
        ok: true as const,
        value: {
          account: {
            ...account,
            mfaEnabled: true,
            mfaMethod: 'totp' as const,
            mfaEnabledAt: now,
          },
          recoveryCodes: recovery.codes,
        },
      };
    });
    if (!outcome.ok) throw this.refusalError(outcome, now);

    this.logger.info('MFA enabled', { context: 'MfaService', userId: authId });
    const { account, recoveryCodes } = outcome.value;
    return {
      ...this.statusView(account, EMPTY_ENROLLMENT, now, {
        counter: {
          failedAttempts: 0,
          failureWindowStartedAt: null,
          blockedUntil: null,
        },
        recovery: { remaining: recoveryCodes.length, generatedAt: now },
      }),
      recoveryCodes,
    };
  }

  /** Counts an incorrect code (committed with the transaction, before the error is returned). */
  private async countFailure(
    locked: LockedMfaAccount,
    now: Date,
  ): Promise<{ ok: false } & Refusal> {
    const { state, blocked } = recordFailure(locked.enrollment, now);
    await locked.saveEnrollment(state);
    if (!blocked) return refuse({ kind: 'INVALID_CODE' });
    this.logger.warn('MFA enrollment blocked after repeated incorrect codes', {
      context: 'MfaService',
      userId: locked.account.authId,
      blockedUntil: state.blockedUntil?.toISOString(),
    });
    return refuse({ kind: 'BLOCKED', until: state.blockedUntil as Date });
  }

  private async locked<T>(
    authId: string,
    work: (locked: LockedMfaAccount) => Promise<Outcome<T>>,
  ): Promise<Outcome<T>> {
    let found: { result: Outcome<T> } | null;
    try {
      found = await this.enrollments.withLockedAccount(
        authId,
        async (locked) => {
          this.assertActive(locked.account);
          return work(locked);
        },
      );
    } catch (error) {
      if (error instanceof MfaEncryptionUnavailableError) {
        this.logger.error('MFA secret encryption is not configured', {
          context: 'MfaService',
        });
        throw AppError.serviceUnavailable('MFA is temporarily unavailable');
      }
      throw error;
    }
    if (!found) throw this.accountUnavailable();
    return found.result;
  }

  private encrypt(
    authId: string,
    slot: 'enrollment' | 'active',
    secret: string,
  ): string {
    return this.cipher.encrypt(authId, slot, secret);
  }

  private readPendingSecret(authId: string, encrypted: string): string | null {
    try {
      return this.cipher.decrypt(authId, 'enrollment', encrypted);
    } catch (error) {
      if (error instanceof SecretDecryptionError) return null;
      throw error;
    }
  }

  private statusView(
    account: MfaAccount,
    enrollment: MfaEnrollmentState,
    now: Date,
    summary: { counter: FailureCounter; recovery: RecoveryCodeSummary } | null,
  ): MfaStatusView {
    if (account.mfaEnabled) {
      const counter = summary?.counter;
      return {
        enabled: true,
        method: account.mfaMethod,
        enabledAt: account.mfaEnabledAt,
        enrollment: null,
        recovery: {
          remainingCodes: summary?.recovery.remaining ?? 0,
          generatedAt: summary?.recovery.generatedAt ?? null,
        },
        verification: {
          remainingAttempts: counter
            ? remainingAttempts(counter, now, MFA_VERIFICATION)
            : MFA_VERIFICATION.MAX_FAILED_ATTEMPTS,
          blockedUntil:
            counter && isBlocked(counter, now) ? counter.blockedUntil : null,
        },
      };
    }
    const status = enrollmentStatus(enrollment, now);
    return {
      enabled: false,
      method: null,
      enabledAt: null,
      enrollment: {
        status,
        expiresAt:
          status === 'PENDING' || status === 'EXPIRED'
            ? enrollment.expiresAt
            : null,
        blockedUntil: status === 'BLOCKED' ? enrollment.blockedUntil : null,
        remainingAttempts: remainingAttempts(enrollment, now),
      },
      recovery: null,
      verification: null,
    };
  }

  private assertActive(account: MfaAccount): void {
    if (account.status !== 'ACTIVE') {
      throw AppError.unauthorized('User account is not active');
    }
  }

  private accountUnavailable(): AppError {
    return AppError.unauthorized('User not found');
  }

  private refusalError(refusal: Refusal, now: Date): AppError {
    switch (refusal.kind) {
      case 'ALREADY_ENABLED':
        return AppError.conflict('MFA is already enabled for this account');
      case 'BLOCKED': {
        const minutes = Math.max(
          1,
          Math.ceil((refusal.until.getTime() - now.getTime()) / 60_000),
        );
        return AppError.tooManyRequests(
          `Too many incorrect authentication codes. MFA enrollment is blocked; try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        );
      }
      case 'NOT_STARTED':
        return AppError.notFound(
          'No MFA enrollment in progress. Start a new enrollment.',
        );
      case 'EXPIRED':
        return AppError.gone(
          'The MFA enrollment has expired. Start a new enrollment.',
        );
      case 'INVALID_CODE':
        return AppError.badRequest('Invalid or expired authentication code');
    }
  }
}
