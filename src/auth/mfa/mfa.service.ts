import { Inject, Injectable } from '@nestjs/common';
import type { mfaMethod, StepUpMethod } from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import AppError from '../../common/errors/app.error';
import type { ActivityLogMetadata } from '../../common/services/activity-log.service';
import {
  activeBlock,
  recentFailures,
  registerFailure,
  remainingAttempts,
} from './mfa-lockout.policy';
import {
  guardMfaStorage,
  mfaBlockedError,
  requireActiveAccount,
} from './mfa-errors';
import { issueRecoveryCodes } from './mfa-recovery-codes';
import {
  MfaRepository,
  type MfaAccountState,
  type MfaEnrollmentState,
  type MfaUnitOfWork,
} from './mfa.repository';
import { MfaSecurityNotifier } from './mfa-security-notifier';
import type { SecurityEventContext } from '../security-events/security-event.log';
import { MfaSecretCipher, MfaSecretDecryptionError } from './mfa-secret.cipher';
import { buildOtpAuthUri, generateTotpSecret, verifyTotp } from './mfa-totp';
import { MFA_AUDIT_FIELDS, MFA_ENROLLMENT, MFA_TOTP } from './mfa.constants';

/**
 * The state of a pending secret: a first enrollment while MFA is off, or an
 * authenticator replacement while it is on.
 * - NONE: none in progress.
 * - PENDING: started and confirmable until `expiresAt`.
 * - EXPIRED: started, but not confirmed within 10 minutes; start again.
 * - BLOCKED: too many incorrect codes; nothing is possible until
 *   `blockedUntil`.
 */
export type MfaEnrollmentStatus = 'NONE' | 'PENDING' | 'EXPIRED' | 'BLOCKED';

export interface MfaStatusView {
  enabled: boolean;
  method: mfaMethod | null;
  /** Unused recovery codes (never the codes); null while MFA is disabled. */
  recoveryCodesRemaining: number | null;
  enrollment: {
    status: MfaEnrollmentStatus;
    expiresAt: Date | null;
    blockedUntil: Date | null;
    /** Incorrect codes still allowed before the block. */
    remainingAttempts: number;
  };
}

/**
 * Returned once, when the enrollment is confirmed: the status and the new
 * recovery codes, which are never shown again and never stored in
 * plaintext.
 */
export interface MfaEnabledView extends MfaStatusView {
  recoveryCodes: string[];
  /** Other sign-in sessions ended by enabling MFA. */
  sessionsRevoked: number;
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
  | { kind: 'NOT_ENABLED' }
  | { kind: 'BLOCKED'; until: Date };

/** A pending secret: a first enrollment, or the replacement of the app. */
type PendingMode = 'enrollment' | 'replacement';

/** Who approved an MFA change, and from where (never a secret). */
export interface MfaChangeContext {
  metadata: ActivityLogMetadata;
  /** The sign-in session making the change (the access token's `sid`). */
  sessionId?: string;
  /** How the step-up was proven (from the approval). */
  approvedWith?: StepUpMethod;
}

/** The status after a management change. */
export interface MfaChangeView extends MfaStatusView {
  trustedDevicesRevoked: number;
}

const changeEventContext = (
  change: MfaChangeContext,
): SecurityEventContext => ({
  ip: change.metadata.ip,
  userAgent: change.metadata.userAgent,
  sessionId: change.sessionId ?? null,
});

/** History entry for trusted devices revoked by an MFA change. */
async function recordDevicesRevoked(
  uow: MfaUnitOfWork,
  count: number,
  reason: 'mfa_enabled' | 'mfa_disabled' | 'authenticator_replaced',
  context: SecurityEventContext,
  now: Date,
) {
  if (count === 0) return;
  await uow.recordEvent({
    type: 'TRUSTED_DEVICE_REVOKED',
    context,
    details: { reason, count },
    now,
  });
}

const approvalChange = (change: MfaChangeContext) =>
  change.approvedWith
    ? [
        {
          fieldName: MFA_AUDIT_FIELDS.STEP_UP_METHOD,
          oldValue: null,
          newValue: change.approvedWith,
        },
      ]
    : [];

type ConfirmOutcome<T> =
  | { kind: 'CONFIRMED'; result: T }
  | { kind: 'ALREADY_ENABLED' }
  | { kind: 'NOT_ENABLED' }
  | { kind: 'BLOCKED'; until: Date }
  | { kind: 'NO_ENROLLMENT' }
  | { kind: 'EXPIRED' }
  | { kind: 'INVALID_CODE'; remainingAttempts: number }
  | { kind: 'BLOCKED_NOW'; until: Date };

const CONTEXT = 'MfaService';

/**
 * Optional MFA with an authenticator app (TOTP) for the signed-in owner:
 * start an enrollment (a new secret, valid for 10 minutes), confirm it with
 * the app's current six-digit code (which also issues the recovery codes),
 * and read whether MFA is enabled.
 *
 * The owner is always the access token's user; no operation accepts another
 * user's ID. Secrets are stored only encrypted. A code is accepted only
 * within its own 30-second step and only once; five incorrect codes within
 * 15 minutes block enrollment for 15 minutes.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly repository: MfaRepository,
    private readonly cipher: MfaSecretCipher,
    private readonly notifier: MfaSecurityNotifier,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async getStatus(
    authId: string,
    now: Date = new Date(),
  ): Promise<MfaStatusView> {
    const { account, enrollment, recoveryCodesRemaining } = await this.guard(
      () => this.repository.read(authId),
    );
    return this.statusView(
      requireActiveAccount(account),
      enrollment,
      recoveryCodesRemaining,
      now,
    );
  }

  /** Starts (or restarts) an enrollment of a user without MFA. */
  startEnrollment(
    authId: string,
    now: Date = new Date(),
    context: SecurityEventContext = {},
  ): Promise<MfaEnrollmentStartView> {
    return this.startPending(authId, 'enrollment', now, context);
  }

  /**
   * Starts (or restarts) the replacement of the authenticator of a user with
   * MFA: a new secret, confirmable for 10 minutes with the new app. The
   * current authenticator keeps working until the replacement is confirmed.
   */
  startReplacement(
    authId: string,
    now: Date = new Date(),
    context: SecurityEventContext = {},
  ): Promise<MfaEnrollmentStartView> {
    return this.startPending(authId, 'replacement', now, context);
  }

  /**
   * Confirms the enrollment and enables MFA. In the same transaction, the
   * sign-in session that confirms it (`sessionId`) stays, and every other
   * session, its approvals, open sign-in challenges and trusted devices are
   * revoked: whatever was signed in before MFA must prove MFA again.
   */
  async confirmEnrollment(
    authId: string,
    code: string,
    metadata: ActivityLogMetadata,
    now: Date = new Date(),
    sessionId?: string,
  ): Promise<MfaEnabledView> {
    const context = {
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      sessionId: sessionId ?? null,
    };
    const { recoveryCodes, sessionsRevoked } = await this.confirmPending(
      authId,
      code,
      'enrollment',
      now,
      async (uow, secret, step) => {
        // The confirmed secret is re-encrypted for its new role; the
        // enrollment (with its pending copy) is removed in the same commit.
        await uow.enableMfa({
          encryptedSecret: this.cipher.encrypt('confirmed', authId, secret),
          usedStep: step,
          metadata: { ...metadata, actionedBy: authId },
        });
        await uow.deleteEnrollment();
        // Ten single-use recovery codes, stored only as salted scrypt hashes,
        // in the same commit; the plaintext leaves only in this response.
        const codes = await issueRecoveryCodes(uow, authId);
        // Everything signed in before MFA ends, except this session.
        const revokedSessions = await uow.revokeOtherSessions(sessionId, now);
        const revokedDevices = await uow.revokeTrustedDevices(now);
        if (sessionId) {
          await uow.markSessionMfaVerified(sessionId, 'totp', now);
        }
        await uow.recordEvent({
          type: 'MFA_ENABLED',
          context,
          details: {
            method: 'totp',
            recoveryCodes: codes.length,
            sessionsRevoked: revokedSessions.length,
            trustedDevicesRevoked: revokedDevices,
          },
          now,
        });
        if (revokedSessions.length > 0) {
          await uow.recordEvent({
            type: 'SESSION_REVOKED',
            context,
            details: {
              scope: 'mfa_enabled',
              count: revokedSessions.length,
              sessionIds: revokedSessions,
              includesCurrentSession: false,
            },
            now,
          });
        }
        await recordDevicesRevoked(
          uow,
          revokedDevices,
          'mfa_enabled',
          context,
          now,
        );
        return {
          recoveryCodes: codes,
          sessionsRevoked: revokedSessions.length,
        };
      },
      context,
    );
    this.logger.info('MFA enabled', {
      context: CONTEXT,
      authId,
      sessionsRevoked,
    });
    return {
      enabled: true,
      method: 'totp',
      recoveryCodesRemaining: recoveryCodes.length,
      enrollment: this.noEnrollment(),
      recoveryCodes,
      sessionsRevoked,
    };
  }

  /**
   * Confirms a replacement with the new app's current code. In one
   * transaction: the new secret replaces the old one (whose codes stop
   * working at once), every trusted device is revoked, and the change and
   * its security notification are recorded. Recovery codes stay valid.
   */
  async confirmReplacement(
    authId: string,
    code: string,
    change: MfaChangeContext,
    now: Date = new Date(),
  ): Promise<MfaChangeView> {
    const context = changeEventContext(change);
    const { revoked, notification } = await this.confirmPending(
      authId,
      code,
      'replacement',
      now,
      async (uow, secret, step) => {
        await uow.replaceMfaSecret({
          encryptedSecret: this.cipher.encrypt('confirmed', authId, secret),
          usedStep: step,
        });
        await uow.deleteEnrollment();
        const revokedDevices = await uow.revokeTrustedDevices(now);
        const metadata = { ...change.metadata, actionedBy: authId };
        await uow.audit(
          [
            {
              fieldName: MFA_AUDIT_FIELDS.AUTHENTICATOR,
              oldValue: null,
              newValue: 'replaced',
            },
            {
              fieldName: MFA_AUDIT_FIELDS.TRUSTED_DEVICES_REVOKED,
              oldValue: null,
              newValue: String(revokedDevices),
            },
            ...approvalChange(change),
          ],
          metadata,
        );
        if (change.sessionId) {
          await uow.markSessionMfaVerified(change.sessionId, 'totp', now);
        }
        await uow.recordEvent({
          type: 'MFA_AUTHENTICATOR_REPLACED',
          context,
          details: {
            trustedDevicesRevoked: revokedDevices,
            approvedWith: change.approvedWith ?? null,
          },
          now,
        });
        await recordDevicesRevoked(
          uow,
          revokedDevices,
          'authenticator_replaced',
          context,
          now,
        );
        return {
          revoked: revokedDevices,
          notification: await this.notifier.record(uow.tx, {
            authId,
            event: 'MFA_AUTHENTICATOR_REPLACED',
            metadata,
            now,
          }),
        };
      },
      context,
    );
    await this.notifier.dispatch(notification);
    this.logger.info('MFA authenticator replaced', {
      context: CONTEXT,
      authId,
      trustedDevicesRevoked: revoked,
    });
    return {
      ...(await this.getStatus(authId, now)),
      trustedDevicesRevoked: revoked,
    };
  }

  /**
   * Turns MFA off. In one transaction: the secret, recovery codes, pending
   * enrollment/replacement, open sign-in challenges and the MFA lockout are
   * removed, every trusted device is revoked, and the change and its
   * security notification are recorded.
   */
  async disable(
    authId: string,
    change: MfaChangeContext,
    now: Date = new Date(),
  ): Promise<MfaChangeView> {
    const outcome = await this.guard(() =>
      this.repository.withLock(authId, async (uow) => {
        const account = requireActiveAccount(await uow.account());
        if (!account.mfaEnabled) return { kind: 'NOT_ENABLED' as const };

        const codesBefore = await uow.countRecoveryCodes();
        await uow.disableMfa();
        const revoked = await uow.revokeTrustedDevices(now);
        const metadata = { ...change.metadata, actionedBy: authId };
        await uow.audit(
          [
            {
              fieldName: MFA_AUDIT_FIELDS.ENABLED,
              oldValue: 'true',
              newValue: 'false',
            },
            {
              fieldName: MFA_AUDIT_FIELDS.METHOD,
              oldValue: account.mfaMethod,
              newValue: null,
            },
            {
              fieldName: MFA_AUDIT_FIELDS.RECOVERY_CODES_REMAINING,
              oldValue: String(codesBefore),
              newValue: '0',
            },
            {
              fieldName: MFA_AUDIT_FIELDS.TRUSTED_DEVICES_REVOKED,
              oldValue: null,
              newValue: String(revoked),
            },
            ...approvalChange(change),
          ],
          metadata,
        );
        const context = changeEventContext(change);
        await uow.recordEvent({
          type: 'MFA_DISABLED',
          context,
          details: {
            recoveryCodesDeleted: codesBefore,
            trustedDevicesRevoked: revoked,
            approvedWith: change.approvedWith ?? null,
          },
          now,
        });
        await recordDevicesRevoked(uow, revoked, 'mfa_disabled', context, now);
        const notification = await this.notifier.record(uow.tx, {
          authId,
          event: 'MFA_DISABLED',
          metadata,
          now,
        });
        return { kind: 'DISABLED' as const, revoked, notification };
      }),
    );
    if (outcome.kind === 'NOT_ENABLED') {
      throw AppError.conflict('MFA is not enabled for this account');
    }
    await this.notifier.dispatch(outcome.notification);
    this.logger.info('MFA disabled', {
      context: CONTEXT,
      authId,
      trustedDevicesRevoked: outcome.revoked,
    });
    return {
      ...(await this.getStatus(authId, now)),
      trustedDevicesRevoked: outcome.revoked,
    };
  }

  private async startPending(
    authId: string,
    mode: PendingMode,
    now: Date,
    context: SecurityEventContext,
  ): Promise<MfaEnrollmentStartView> {
    const outcome = await this.guard(() =>
      this.repository.withLock<StartOutcome>(authId, async (uow) => {
        const account = requireActiveAccount(await uow.account());
        if (mode === 'enrollment' && account.mfaEnabled) {
          return { kind: 'ALREADY_ENABLED' };
        }
        if (mode === 'replacement' && !account.mfaEnabled) {
          return { kind: 'NOT_ENABLED' };
        }

        const enrollment = await uow.enrollment();
        const blockedUntil = activeBlock(enrollment?.blockedUntil, now);
        if (blockedUntil) return { kind: 'BLOCKED', until: blockedUntil };

        const secret = generateTotpSecret();
        const expiresAt = new Date(now.getTime() + MFA_ENROLLMENT.TTL_MS);
        // A restart replaces the secret and its expiry, but keeps the
        // failures that still count: restarting never resets the lockout.
        await uow.saveEnrollment({
          secret: this.cipher.encrypt('enrollment', authId, secret),
          expiresAt,
          failedAttemptsAt: recentFailures(
            enrollment?.failedAttemptsAt ?? [],
            now,
          ),
          blockedUntil: null,
        });
        await uow.recordEvent({
          type:
            mode === 'enrollment'
              ? 'MFA_ENROLLMENT_STARTED'
              : 'MFA_AUTHENTICATOR_REPLACEMENT_STARTED',
          context,
          details: { expiresAt: expiresAt.toISOString() },
          now,
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
        this.logger.info(
          mode === 'enrollment'
            ? 'MFA enrollment started'
            : 'MFA authenticator replacement started',
          { context: CONTEXT, authId },
        );
        return outcome.view;
      case 'ALREADY_ENABLED':
        throw this.alreadyEnabled();
      case 'NOT_ENABLED':
        throw AppError.conflict('MFA is not enabled for this account');
      case 'BLOCKED':
        throw this.blocked(outcome.until);
    }
  }

  /**
   * Confirms a pending secret (enrollment or replacement) with the app's
   * current code, under the user's lock. `onVerified` makes the change in
   * the same transaction. Wrong codes count toward the enrollment lockout.
   */
  private async confirmPending<T>(
    authId: string,
    code: string,
    mode: PendingMode,
    now: Date,
    onVerified: (
      uow: MfaUnitOfWork,
      secret: string,
      step: number,
    ) => Promise<T>,
    context: SecurityEventContext = {},
  ): Promise<T> {
    const outcome = await this.guard(() =>
      this.repository.withLock<ConfirmOutcome<T>>(authId, async (uow) => {
        const account = requireActiveAccount(await uow.account());
        // Enrollment: also answers a replay of the code that enabled MFA.
        if (mode === 'enrollment' && account.mfaEnabled) {
          return { kind: 'ALREADY_ENABLED' };
        }
        if (mode === 'replacement' && !account.mfaEnabled) {
          return { kind: 'NOT_ENABLED' };
        }

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
          secret = this.cipher.decrypt('enrollment', authId, enrollment.secret);
        } catch (error) {
          // A missing key is an outage (503); an unreadable secret (e.g. a
          // key that was removed) means the user starts again.
          if (!(error instanceof MfaSecretDecryptionError)) throw error;
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
          // History: never the code, only where it failed.
          await uow.recordEvent({
            type: failure.blockedUntil
              ? 'MFA_VERIFICATION_BLOCKED'
              : 'MFA_VERIFICATION_FAILED',
            context,
            details: failure.blockedUntil
              ? {
                  context: mode,
                  method: 'totp',
                  blockedUntil: failure.blockedUntil.toISOString(),
                }
              : {
                  context: mode,
                  method: 'totp',
                  remainingAttempts: failure.remainingAttempts,
                },
            now,
          });
          if (failure.blockedUntil) {
            // The pending secret is discarded; a new one can start after
            // the block.
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

        return {
          kind: 'CONFIRMED',
          result: await onVerified(uow, secret, check.step),
        };
      }),
    );

    const what =
      mode === 'enrollment' ? 'MFA enrollment' : 'authenticator replacement';
    switch (outcome.kind) {
      case 'CONFIRMED':
        return outcome.result;
      case 'ALREADY_ENABLED':
        throw this.alreadyEnabled();
      case 'NOT_ENABLED':
        throw AppError.conflict('MFA is not enabled for this account');
      case 'BLOCKED':
        throw this.blocked(outcome.until);
      case 'NO_ENROLLMENT':
        throw AppError.conflict(
          mode === 'enrollment'
            ? 'No MFA enrollment is in progress. Start a new enrollment.'
            : 'No authenticator replacement is in progress. Start a new one.',
        );
      case 'EXPIRED':
        throw AppError.gone(
          mode === 'enrollment'
            ? 'The MFA enrollment has expired. Start a new enrollment.'
            : 'The authenticator replacement has expired. Start a new one.',
        );
      case 'INVALID_CODE':
        this.logger.warn(`Incorrect ${what} code`, {
          context: CONTEXT,
          authId,
          remainingAttempts: outcome.remainingAttempts,
        });
        throw AppError.badRequest(
          `Invalid or expired authenticator code. ${outcome.remainingAttempts} attempt(s) remaining.`,
        );
      case 'BLOCKED_NOW':
        this.logger.warn(`${what} blocked after incorrect codes`, {
          context: CONTEXT,
          authId,
        });
        throw this.blocked(outcome.until);
    }
  }

  private statusView(
    account: MfaAccountState,
    enrollment: MfaEnrollmentState | null,
    recoveryCodesRemaining: number,
    now: Date,
  ): MfaStatusView {
    // `enrollment` describes a pending secret: a first enrollment while MFA
    // is off, an authenticator replacement while it is on.
    const failures = enrollment?.failedAttemptsAt ?? [];
    const blockedUntil = activeBlock(enrollment?.blockedUntil, now);
    let status: MfaEnrollmentStatus = 'NONE';
    if (blockedUntil) status = 'BLOCKED';
    else if (enrollment?.secret && enrollment.expiresAt) {
      status =
        enrollment.expiresAt.getTime() > now.getTime() ? 'PENDING' : 'EXPIRED';
    }
    return {
      enabled: account.mfaEnabled,
      method: account.mfaEnabled ? account.mfaMethod : null,
      recoveryCodesRemaining: account.mfaEnabled
        ? recoveryCodesRemaining
        : null,
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

  private guard<T>(operation: () => Promise<T>): Promise<T> {
    return guardMfaStorage(this.logger, CONTEXT, operation);
  }

  private alreadyEnabled(): AppError {
    return AppError.conflict('MFA is already enabled for this account');
  }

  private blocked(until: Date): AppError {
    return mfaBlockedError('MFA enrollment', until);
  }
}
