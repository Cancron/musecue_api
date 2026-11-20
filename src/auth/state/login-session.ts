import type { Prisma } from '@prisma/client';
import AppError from '../../common/errors/app.error';
import { AUTH_CONFIG } from '../config/auth.config';
import type { AuthUtilsService } from '../services/auth-utils.service';
import {
  LoginInProgressError,
  type RefreshSessionRepository,
} from './refresh-session.repository';

/**
 * How a sign-in skipped the MFA challenge: the account had no MFA, or the
 * request came from one of the user's trusted devices.
 */
export type MfaSkip =
  | { kind: 'NOT_REQUIRED' }
  | { kind: 'TRUSTED_DEVICE'; deviceId: string };

/** The MFA decision of a sign-in no longer holds (see confirmMfaSkip). */
export class MfaStateChangedError extends Error {
  constructor() {
    super('MFA state changed during sign-in');
    this.name = 'MfaStateChangedError';
  }
}

/**
 * Re-checks, under the user's sessions lock, that a sign-in may still skip
 * MFA: MFA enabled concurrently (whose activation ends every other session
 * under the same lock), or the trusted device revoked meanwhile, means the
 * session is not stored. Without this, a password sign-in that passed the
 * MFA gate just before MFA was enabled could store a session right after the
 * activation ended all others.
 */
export async function confirmMfaSkip(
  tx: Prisma.TransactionClient,
  authId: string,
  skipped: MfaSkip,
  now: Date,
): Promise<void> {
  const security = await tx.authSecurity.findUnique({
    where: { authId },
    select: { mfaEnabled: true },
  });
  if (skipped.kind === 'NOT_REQUIRED') {
    if (security?.mfaEnabled) throw new MfaStateChangedError();
    return;
  }
  const trusted = await tx.mfaTrustedDevice.count({
    where: {
      id: skipped.deviceId,
      authId,
      revokedAt: null,
      expiresAt: { gt: now },
    },
  });
  if (!security?.mfaEnabled || trusted === 0) {
    throw new MfaStateChangedError();
  }
}

/** Milliseconds a refresh token (and its session) lives. */
export function refreshTokenLifetimeMs(): number {
  const match = /^(\d+)([smhd])?$/.exec(AUTH_CONFIG.TOKEN_EXPIRY.REFRESH);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? 's'] ?? 1;
  return parseInt(match[1], 10) * unit * 1000;
}

/**
 * Stores the refresh session of a new login (password or Google sign-in):
 * only the token's hash is kept, a concurrent login of the same user is
 * rejected (409), and the oldest sessions beyond the device limit are
 * revoked. Fails with 503 when the session cannot be stored. With `tx`, the
 * session is written inside that transaction (all-or-nothing with it).
 * `familyId` identifies the new sign-in session (the access token's `sid`).
 */
export async function storeLoginSession(
  sessions: RefreshSessionRepository,
  utils: AuthUtilsService,
  userId: string,
  jti: string,
  refreshToken: string,
  meta: { ip: string; userAgent: string; device?: string },
  options: {
    tx?: Prisma.TransactionClient;
    familyId?: string;
    /** The sign-in proved MFA (the MFA challenge), and how. */
    mfaVerifiedWith?: 'totp' | 'recovery_code';
    /** The sign-in skipped MFA: re-checked under the sessions lock. */
    skippedMfa?: MfaSkip;
  } = {},
): Promise<void> {
  try {
    await sessions.createForLogin(
      {
        authId: userId,
        tokenId: jti,
        tokenHash: utils.hashToken(refreshToken),
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        device: meta.device,
        expiresAt: new Date(Date.now() + refreshTokenLifetimeMs()),
        familyId: options.familyId,
        ...(options.mfaVerifiedWith
          ? {
              mfaVerifiedAt: new Date(),
              mfaVerifiedWith: options.mfaVerifiedWith,
            }
          : {}),
      },
      AUTH_CONFIG.SESSION.MAX_DEVICES_PER_USER,
      undefined,
      options.tx,
      options.skippedMfa
        ? (tx) =>
            confirmMfaSkip(
              tx,
              userId,
              options.skippedMfa as MfaSkip,
              new Date(),
            )
        : undefined,
    );
  } catch (error) {
    if (error instanceof MfaStateChangedError) {
      throw AppError.conflict(
        'Your sign-in settings changed while you were signing in. Please sign in again.',
      );
    }
    if (error instanceof LoginInProgressError) {
      throw AppError.conflict(
        'Another login is in progress. Please try again in a moment.',
      );
    }
    console.error('Failed to store refresh session:', {
      userId,
      error: error instanceof Error ? error.name : String(error),
    });
    throw AppError.serviceUnavailable(
      'Authentication service temporarily unavailable. Please try again.',
    );
  }
}
