/**
 * Authentication Configuration Constants
 */

import type { UserRole } from '../interfaces/auth.interface';

export const AUTH_CONFIG = {
  // Password Configuration
  PASSWORD_MIN_LENGTH: 6,

  // Token Configuration
  TOKEN_EXPIRY: {
    ACCESS: '15m', // Short-lived for security (was 1h)
    REFRESH: '7d',
    VERIFICATION: '24h',
    PASSWORD_RESET: '1h',
  },

  // Rate Limiting (no user-agent keys, to prevent key explosion)
  RATE_LIMIT: {
    LOGIN_MAX_ATTEMPTS: 5,
    LOGIN_WINDOW_MS: 15 * 60 * 1000, // 15 minutes
    PASSWORD_RESET_MAX_ATTEMPTS: 3,
    PASSWORD_RESET_WINDOW_MS: 60 * 60 * 1000, // 1 hour
  },

  // Account Lockout
  ACCOUNT_LOCKOUT: {
    MAX_FAILED_ATTEMPTS: 5,
    LOCKOUT_DURATION_MS: 30 * 60 * 1000, // 30 minutes
  },

  // Checks allowed per email verification code (a new code resets them)
  VERIFICATION_CODE_MAX_ATTEMPTS: 5,

  // Session/Device Management
  SESSION: {
    MAX_DEVICES_PER_USER: 5, // Max concurrent refresh tokens per user
  },

  // Role Hierarchy (higher number = more permissions)
  ROLE_HIERARCHY: {
    USER: 1,
    MODERATOR: 2,
    ADMIN: 3,
    SUPERADMIN: 4,
  } satisfies Record<UserRole, number>,
} as const;
