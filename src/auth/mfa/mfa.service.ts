import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { mfaMethod } from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import AppError from '../../common/errors/app.error';
import type { ActivityLogMetadata } from '../../common/services/activity-log.service';
import { SecretDecryptionError } from '../../common/security/derived-secrets';
import {
  activeBlock,
  recentFailures,
  registerFailure,
  remainingAttempts,
} from './mfa-enrollment.policy';
import {
  MfaEnrollmentRepository,
  type MfaAccountState,
  type MfaEnrollmentState,
} from './mfa-enrollment.repository';
import { decryptMfaSecret, encryptMfaSecret } from './mfa-secret.cipher';
import { buildOtpAuthUri, generateTotpSecret, verifyTotp } from './mfa-totp';
import { MFA_ENROLLMENT, MFA_TOTP } from './mfa.constants';

/**
 * - NONE: no enrollment in progress (including after MFA was enabled).
 * - PENDING: started and confirmable until `expiresAt`.
 * - EXPIRED: started, but not confirmed within 10 minutes; start again.
 * - BLOCKED: too many incorrect codes; nothing is possible until
 *   `blockedUntil`.
 */
export type MfaEnrollmentStatus = 'NONE' | 'PENDING' | 'EXPIRED' | 'BLOCKED';

export interface MfaStatusView {
  enabled: boolean;
  method: mfaMethod | null;
  enrollment: {
    status: MfaEnrollmentStatus;
    expiresAt: Date | null;
    blockedUntil: Date | null;
    /** Incorrect codes still allowed before the block. */
    remainingAttempts: number;
  };
}

/** Returned once, when an enrollment starts; never stored in plaintext. */
export interface MfaEnrollmentStartView {
  /** Base32 secret for manual entry in the authenticator app. */
  secret: string;
  /** otpauth:// URI for a QR code. */
  otpauthUrl: string;
  issuer: string;
  algorithm: string;
  digits: number;
  period: number;
  expiresAt: Date;
}

type StartOutcome =
  | { kind: 'STARTED'; view: MfaEnrollmentStartView }
  | { kind: 'ALREADY_ENABLED' }
  | { kind: 'BLOCKED'; until: Date };

type ConfirmOutcome =
  | { kind: 'ENABLED' }
  | { kind: 'ALREADY_ENABLED' }
  | { kind: 'BLOCKED'; until: Date }
  | { kind: 'NO_ENROLLMENT' }
  | { kind: 'EXPIRED' }
  | { kind: 'INVALID_CODE'; remainingAttempts: number }
  | { kind: 'BLOCKED_NOW'; until: Date };

const CONTEXT = 'MfaService';

/**
 * Optional MFA with an authenticator app (TOTP) for the signed-in owner:
 * start an enrollment (a new secret, valid for 10 minutes), confirm it with
 * the app's current six-digit code, and read whether MFA is enabled.
 *
 * The owner is always the access token's user; no operation accepts another
 * user's ID. Secrets are stored only encrypted. A code is accepted only
 * within its own 30-second step and only once; five incorrect codes within
 * 15 minutes block enrollment for 15 minutes.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly repository: MfaEnrollmentRepository,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async getStatus(
    authId: string,
    now: Date = new Date(),
  ): Promise<MfaStatusView> {
    const { account, enrollment } = await this.guard(() =>
      this.repository.read(authId),
    );
    return this.statusView(this.requireActive(account), enrollment, now);
  }

  async startEnrollment(
    authId: string,
    now: Date = new Date(),
  ): Promise<MfaEnrollmentStartView> {
    const outcome = await this.guard(() =>
      this.repository.withLock<StartOutcome>(authId, async (uow) => {
        const account = this.requireActive(await uow.account());
        if (account.mfaEnabled) return { kind: 'ALREADY_ENABLED' };

        const enrollment = await uow.enrollment();
        const blockedUntil = activeBlock(enrollment?.blockedUntil, now);
        if (blockedUntil) return { kind: 'BLOCKED', until: blockedUntil };

        const secret = generateTotpSecret();
        const expiresAt = new Date(now.getTime() + MFA_ENROLLMENT.TTL_MS);
        // A restart replaces the secret and its expiry, but keeps the
        // failures that still count: restarting never resets the lockout.
        await uow.saveEnrollment({
          secret: encryptMfaSecret('enrollment', authId, secret),
          expiresAt,
          failedAttemptsAt: recentFailures(
            enrollment?.failedAttemptsAt ?? [],
            now,
          ),
          blockedUntil: null,
        });
        return {
          kind: 'STARTED',
          view: {
            secret,
            otpauthUrl: buildOtpAuthUri(secret, account.email),
            issuer: MFA_TOTP.ISSUER,
            algorithm: MFA_TOTP.ALGORITHM,
            digits: MFA_TOTP.DIGITS,
            period: MFA_TOTP.PERIOD_SECONDS,
            expiresAt,
          },
        };
      }),
    );

    switch (outcome.kind) {
      case 'STARTED':
        this.logger.info('MFA enrollment started', {
          context: CONTEXT,
          authId,
        });
        return outcome.view;
      case 'ALREADY_ENABLED':
        throw this.alreadyEnabled();
      case 'BLOCKED':
        throw this.blocked(outcome.until);
    }
  }

  async confirmEnrollment(
    authId: string,
    code: string,
    metadata: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<MfaStatusView> {
    const outcome = await this.guard(() =>
      this.repository.withLock<ConfirmOutcome>(authId, async (uow) => {
        const account = this.requireActive(await uow.account());
        // Also answers a replay of the code that enabled MFA.
        if (account.mfaEnabled) return { kind: 'ALREADY_ENABLED' };

        const enrollment = await uow.enrollment();
        const blockedUntil = activeBlock(enrollment?.blockedUntil, now);
        if (blockedUntil) return { kind: 'BLOCKED', until: blockedUntil };
        if (!enrollment?.secret || !enrollment.expiresAt) {
          return { kind: 'NO_ENROLLMENT' };
        }

        const forgetSecret = () =>
          uow.saveEnrollment({
            secret: null,
            expiresAt: null,
            failedAttemptsAt: recentFailures(enrollment.failedAttemptsAt, now),
            blockedUntil: null,
          });

        if (enrollment.expiresAt.getTime() <= now.getTime()) {
          await forgetSecret();
          return { kind: 'EXPIRED' };
        }

        let secret: string;
        try {
          secret = decryptMfaSecret('enrollment', authId, enrollment.secret);
        } catch (error) {
          if (!(error instanceof SecretDecryptionError)) throw error;
          // Unreadable (e.g. the key changed): the user starts again.
          this.logger.warn('Pending MFA secret could not be decrypted', {
            context: CONTEXT,
            authId,
          });
          await forgetSecret();
          return { kind: 'EXPIRED' };
        }

        const check = verifyTotp(secret, code, now);
        if (check.result !== 'VALID') {
          const failure = registerFailure(enrollment.failedAttemptsAt, now);
          if (failure.blockedUntil) {
            // The enrollment is discarded; a new one can start after the
            // block, with a new secret.
            await uow.saveEnrollment({
              secret: null,
              expiresAt: null,
              failedAttemptsAt: failure.failedAttemptsAt,
              blockedUntil: failure.blockedUntil,
            });
            return { kind: 'BLOCKED_NOW', until: failure.blockedUntil };
          }
          await uow.saveEnrollment({
            ...enrollment,
            failedAttemptsAt: failure.failedAttemptsAt,
            blockedUntil: null,
          });
          return {
            kind: 'INVALID_CODE',
            remainingAttempts: failure.remainingAttempts,
          };
        }

        // The confirmed secret is re-encrypted for its new role; the
        // enrollment (with its pending copy) is removed in the same commit.
        await uow.enableMfa({
          encryptedSecret: encryptMfaSecret('confirmed', authId, secret),
          usedStep: check.step,
          metadata: { ...metadata, actionedBy: authId },
        });
        await uow.deleteEnrollment();
        return { kind: 'ENABLED' };
      }),
    );

    switch (outcome.kind) {
      case 'ENABLED':
        this.logger.info('MFA enabled', { context: CONTEXT, authId });
        return {
          enabled: true,
          method: 'totp',
          enrollment: this.noEnrollment(),
        };
      case 'ALREADY_ENABLED':
        throw this.alreadyEnabled();
      case 'BLOCKED':
        throw this.blocked(outcome.until);
      case 'NO_ENROLLMENT':
        throw AppError.conflict(
          'No MFA enrollment is in progress. Start a new enrollment.',
        );
      case 'EXPIRED':
        throw AppError.gone(
          'The MFA enrollment has expired. Start a new enrollment.',
        );
      case 'INVALID_CODE':
        this.logger.warn('Incorrect MFA enrollment code', {
          context: CONTEXT,
          authId,
          remainingAttempts: outcome.remainingAttempts,
        });
        throw AppError.badRequest(
          `Invalid or expired authenticator code. ${outcome.remainingAttempts} attempt(s) remaining.`,
        );
      case 'BLOCKED_NOW':
        this.logger.warn('MFA enrollment blocked after incorrect codes', {
          context: CONTEXT,
          authId,
        });
        throw this.blocked(outcome.until);
    }
  }

  private statusView(
    account: MfaAccountState,
    enrollment: MfaEnrollmentState | null,
    now: Date,
  ): MfaStatusView {
    if (account.mfaEnabled) {
      return {
        enabled: true,
        method: account.mfaMethod,
        enrollment: this.noEnrollment(),
      };
    }
    const failures = enrollment?.failedAttemptsAt ?? [];
    const blockedUntil = activeBlock(enrollment?.blockedUntil, now);
    let status: MfaEnrollmentStatus = 'NONE';
    if (blockedUntil) status = 'BLOCKED';
    else if (enrollment?.secret && enrollment.expiresAt) {
      status =
        enrollment.expiresAt.getTime() > now.getTime() ? 'PENDING' : 'EXPIRED';
    }
    return {
      enabled: false,
      method: null,
      enrollment: {
        status,
        expiresAt:
          status === 'PENDING' || status === 'EXPIRED'
            ? (enrollment?.expiresAt ?? null)
            : null,
        blockedUntil,
        remainingAttempts: blockedUntil ? 0 : remainingAttempts(failures, now),
      },
    };
  }

  private noEnrollment(): MfaStatusView['enrollment'] {
    return {
      status: 'NONE',
      expiresAt: null,
      blockedUntil: null,
      remainingAttempts: MFA_ENROLLMENT.MAX_FAILED_ATTEMPTS,
    };
  }

  /** The token's user must still exist and be active. */
  private requireActive(account: MfaAccountState | null): MfaAccountState {
    if (!account) throw AppError.unauthorized('User not found');
    if (account.status !== 'ACTIVE') {
      throw AppError.forbidden('User account is not active');
    }
    return account;
  }

  /**
   * Storage or key failures become a 503, never a wrong-code answer; HTTP
   * errors raised inside the transaction pass through.
   */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('MFA state could not be read or written', {
        context: CONTEXT,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw AppError.serviceUnavailable(
        'MFA is temporarily unavailable. Please try again.',
      );
    }
  }

  private alreadyEnabled(): AppError {
    return AppError.conflict('MFA is already enabled for this account');
  }

  private blocked(until: Date): AppError {
    return AppError.tooManyRequests(
      `Too many incorrect codes. MFA enrollment is blocked until ${until.toISOString()}.`,
    );
  }
}
