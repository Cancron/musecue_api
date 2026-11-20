import type { Prisma } from '@prisma/client';
import AppError from '../../common/errors/app.error';
import { AUTH_CONFIG } from '../config/auth.config';
import type { AuthUtilsService } from '../services/auth-utils.service';
import {
  LoginInProgressError,
  type RefreshSessionRepository,
} from './refresh-session.repository';

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
    );
  } catch (error) {
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
