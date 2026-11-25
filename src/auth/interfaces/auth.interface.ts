/**
 * Authentication-related interfaces and types
 */

import { userRole } from '@prisma/client';

/**
 * Application roles. Derived from the Prisma `userRole` enum so the names used
 * in code are exactly the values stored in the database and carried in access
 * tokens (`USER`, `MODERATOR`, `ADMIN`, `SUPERADMIN`).
 */
export const UserRole = userRole;
export type UserRole = userRole;

/**
 * Access token payload - minimal for stateless auth
 * tokenVersion enables immediate revocation without full DB lookup
 */
export interface IAccessTokenPayload {
  userId: string;
  role: UserRole;
  tokenVersion: number; // Incremented on security events (block, password change, etc.)
  /** The sign-in session (RefreshSession.sessionId); binds step-up approvals. */
  sid?: string;
  iat?: number;
  exp?: number;
}

/**
 * Refresh token payload - minimal data
 * JTI is set via JWT standard claims, not in payload
 */
export interface IRefreshTokenPayload {
  userId: string;
  iat?: number;
  exp?: number;
}

/**
 * @deprecated Use IAccessTokenPayload or IRefreshTokenPayload
 */
export interface ITokenPayload {
  userId: string;
  email: string;
  role: UserRole;
  jti?: string;
  iat?: number;
  exp?: number;
}

/**
 * Login response structure
 */
export interface ILoginResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
    verified: boolean;
  };
  expiresIn: number;
}

/**
 * Response of a completed MFA sign-in (POST /auth/mfa/challenge): the
 * regular tokens, how MFA was satisfied, and - when the device was trusted -
 * its trusted-device token (shown this one time; send it as the
 * X-Trusted-Device-Token header on later sign-ins).
 */
export interface IMfaLoginResponse extends ILoginResponse {
  mfa: {
    method: 'totp' | 'recovery_code';
    remainingRecoveryCodes: number;
  };
  trustedDevice: {
    id: string;
    token: string;
    name: string;
    expiresAt: Date;
  } | null;
}
