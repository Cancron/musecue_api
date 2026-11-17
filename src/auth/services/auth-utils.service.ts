import { Injectable } from '@nestjs/common';
import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import httpStatus from 'http-status';
import config from '../../common/config/app.config';
import {
  IAccessTokenPayload,
  IRefreshTokenPayload,
  ITokenPayload,
  UserRole,
} from '../interfaces/auth.interface';
import { AUTH_CONFIG } from '../config/auth.config';
import { RateLimitStore } from '../../infrastructure/rate-limit/rate-limit.store';
import AppError from '../../common/errors/app.error';
import crypto from 'crypto';

interface TokenOptions {
  isRefresh?: boolean;
  expiresIn?: SignOptions['expiresIn'];
}

/**
 * Authentication Utility Service
 * Provides various authentication-related utilities
 */
@Injectable()
export class AuthUtilsService {
  constructor(private readonly rateLimits: RateLimitStore) {}

  /**
   * Generates a cryptographically secure random ID
   * Used for JTI (JWT ID) to prevent collisions
   */
  generateSecureId(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generates a random verification code
   */
  generateVerificationCode = (): string => {
    return crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
  };

  /**
   * Hash a token using SHA-256 for secure storage
   * Never store raw tokens - only hashes
   */
  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Creates an access token (stateless, minimal payload)
   */
  createAccessToken(
    payload: IAccessTokenPayload,
    expiresIn?: SignOptions['expiresIn'],
  ): string {
    const secret = config.jwt_access_secret;
    if (!secret) {
      throw new AppError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'JWT access secret is not configured',
      );
    }

    const signOptions: SignOptions = {
      expiresIn: expiresIn || AUTH_CONFIG.TOKEN_EXPIRY.ACCESS,
      algorithm: 'HS256',
    };

    return jwt.sign(payload, secret, signOptions);
  }

  /**
   * Creates a refresh token with JTI for revocation capability
   */
  createRefreshToken(
    payload: IRefreshTokenPayload,
    jti: string,
    expiresIn?: SignOptions['expiresIn'],
  ): string {
    const secret = config.jwt_refresh_secret;
    if (!secret) {
      throw new AppError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'JWT refresh secret is not configured',
      );
    }

    const signOptions: SignOptions = {
      expiresIn: expiresIn || AUTH_CONFIG.TOKEN_EXPIRY.REFRESH,
      algorithm: 'HS256',
      jwtid: jti, // Embed JTI in JWT standard claim
    };

    return jwt.sign(payload, secret, signOptions);
  }

  /**
   * @deprecated Use createAccessToken or createRefreshToken
   * Creates a JWT token with proper options
   */
  createToken(payload: ITokenPayload, options: TokenOptions = {}): string {
    const { isRefresh = false, expiresIn } = options;
    const secret = isRefresh
      ? config.jwt_refresh_secret
      : config.jwt_access_secret;
    const defaultExpiry = isRefresh ? '7d' : '1h';

    const signOptions: SignOptions = {
      expiresIn: expiresIn || defaultExpiry,
      algorithm: 'HS256',
    };

    if (!secret) {
      throw new AppError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'JWT secret is not configured',
      );
    }

    return jwt.sign(payload, secret, signOptions);
  }

  /**
   * Verifies an access token
   */
  verifyAccessToken(token: string): IAccessTokenPayload & JwtPayload {
    const secret = config.jwt_access_secret;
    if (!secret) {
      throw new AppError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'JWT access secret is not configured',
      );
    }
    return jwt.verify(token, secret) as IAccessTokenPayload & JwtPayload;
  }

  /**
   * Verifies a refresh token and returns payload with JTI
   */
  verifyRefreshToken(token: string): IRefreshTokenPayload & JwtPayload {
    const secret = config.jwt_refresh_secret;
    if (!secret) {
      throw new AppError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'JWT refresh secret is not configured',
      );
    }
    return jwt.verify(token, secret) as IRefreshTokenPayload & JwtPayload;
  }

  /**
   * @deprecated Use verifyAccessToken or verifyRefreshToken
   * Verifies a JWT token
   */
  verifyToken(token: string): JwtPayload {
    const secret = config.jwt_access_secret;
    if (!secret) {
      throw new AppError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'JWT secret is not configured',
      );
    }
    return jwt.verify(token, secret) as JwtPayload;
  }

  /**
   * Checks a custom rate limit (login, registration, resend and deletion
   * limits) on the selected rate-limit store: `maxAttempts` per `windowMs`,
   * then refused for `windowMs`. When the store itself is unavailable the
   * check is skipped, as before; the account lockout still applies.
   */
  async checkRateLimit(
    key: string,
    maxAttempts: number,
    windowMs: number,
  ): Promise<boolean> {
    let blocked: boolean;
    try {
      ({ blocked } = await this.rateLimits.hit(key, {
        limit: maxAttempts,
        windowMs,
        blockMs: windowMs,
      }));
    } catch {
      return true;
    }

    if (blocked) {
      throw new AppError(
        httpStatus.TOO_MANY_REQUESTS,
        `Rate limit exceeded. Please try again after ${windowMs / 1000} seconds.`,
      );
    }

    return true;
  }

  /** Forgets a custom rate limit (e.g. for an erased account). */
  async resetRateLimit(key: string): Promise<void> {
    await this.rateLimits.reset(key);
  }

  /**
   * Validates the minimum password length
   */
  validatePassword(password: string): boolean {
    return password.length >= AUTH_CONFIG.PASSWORD_MIN_LENGTH;
  }

  /**
   * Checks if a user can modify another user's role based on role hierarchy
   */
  canModifyRole(
    currentUserRole: UserRole,
    targetUserRole: UserRole,
    newRole: UserRole,
  ): boolean {
    const { ROLE_HIERARCHY } = AUTH_CONFIG;

    // Super admin can modify any role except other super admins
    if (currentUserRole === UserRole.SUPERADMIN) {
      return (
        targetUserRole !== UserRole.SUPERADMIN &&
        newRole !== UserRole.SUPERADMIN
      );
    }

    // Admin can only modify moderator and user roles
    if (currentUserRole === UserRole.ADMIN) {
      const targetRoleLevel =
        ROLE_HIERARCHY[targetUserRole as keyof typeof ROLE_HIERARCHY] || 0;
      const newRoleLevel =
        ROLE_HIERARCHY[newRole as keyof typeof ROLE_HIERARCHY] || 0;
      const adminLevel = ROLE_HIERARCHY[UserRole.ADMIN];

      return targetRoleLevel < adminLevel && newRoleLevel < adminLevel;
    }

    // Moderator can only modify user roles
    if (currentUserRole === UserRole.MODERATOR) {
      return targetUserRole === UserRole.USER && newRole === UserRole.USER;
    }

    // Regular users cannot modify any roles
    if (currentUserRole === UserRole.USER) {
      return false;
    }

    return false;
  }
}
