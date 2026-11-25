import type { mfaMethod } from '@prisma/client';
import type { MfaEnrollmentStatus } from './mfa-enrollment.policy';

/** GET /v1/auth/mfa and the result of a confirmed enrollment. */
export interface MfaStatusView {
  enabled: boolean;
  method: mfaMethod | null;
  enabledAt: Date | null;
  /** Enrollment progress; null once MFA is enabled. */
  enrollment: {
    status: MfaEnrollmentStatus;
    /** When a pending (or expired) enrollment stops/stopped accepting codes. */
    expiresAt: Date | null;
    /** While BLOCKED: when enrollment can be started again. */
    blockedUntil: Date | null;
    /** Incorrect codes allowed before enrollment is blocked. */
    remainingAttempts: number;
  } | null;
  /** Recovery codes (counts only, never the codes); null while MFA is off. */
  recovery: {
    /** Unused codes of the current set. */
    remainingCodes: number;
    generatedAt: Date | null;
  } | null;
  /** MFA verification attempts; null while MFA is off. */
  verification: {
    remainingAttempts: number;
    /** While blocked after too many incorrect codes. */
    blockedUntil: Date | null;
  } | null;
}

/**
 * The confirmed enrollment: the status plus the first recovery codes, the
 * only time they are returned.
 */
export interface MfaActivationView extends MfaStatusView {
  recoveryCodes: string[];
}

export type MfaVerificationMethod = 'totp' | 'recovery_code';

/** POST /v1/auth/mfa/verify. */
export interface MfaVerificationView {
  verified: true;
  method: MfaVerificationMethod;
  /** Unused recovery codes left (regenerate before they run out). */
  remainingRecoveryCodes: number;
}

/** POST /v1/auth/mfa/recovery-codes: the new set, returned only this once. */
export interface MfaRecoveryCodesView {
  recoveryCodes: string[];
  generatedAt: Date;
  remainingRecoveryCodes: number;
}

/**
 * POST /v1/auth/mfa/enrollment. Contains the secret: shown to the owner once
 * (as a QR code of `otpauthUrl` or for manual entry) and never logged.
 */
export interface MfaEnrollmentView {
  method: 'totp';
  secret: string;
  otpauthUrl: string;
  issuer: string;
  accountName: string;
  algorithm: 'SHA1';
  digits: number;
  period: number;
  expiresAt: Date;
}
