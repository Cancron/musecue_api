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
  /**
   * The sign-in session (RefreshSession.familyId), stable across refreshes.
   * Step-up approvals are bound to it. Absent in tokens issued before
   * sessions were identified.
   */
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
  /** Always false here; an MFA challenge response has `mfaRequired: true`. */
  mfaRequired: false;
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

/** Tokens of a sign-in completed with MFA (POST /auth/login/mfa). */
export interface IMfaLoginResponse extends ILoginResponse {
  /** How MFA was completed; `sms` sessions carry no MFA proof. */
  mfaMethod: 'totp' | 'recovery_code' | 'sms';
  /** Set when the device was trusted: the token is shown only here. */
  trustedDevice: {
    id: string;
    token: string;
    name: string;
    expiresAt: Date;
  } | null;
}
