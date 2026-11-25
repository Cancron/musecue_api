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
