import { Injectable } from '@nestjs/common';
import { CreateAuthDto } from './dto/create-auth.dto';
import { AuthUtilsService } from './services/auth-utils.service';
import { AUTH_CONFIG } from './config/auth.config';
import { PrismaService } from '../common/services/prisma.service';
import { ActivityLogService } from '../common/services/activity-log.service';
import { ReferralRegistrationService } from '../referrals/referral-registration.service';
import { NotificationService } from '../notifications/notification.service';
import {
  type NotificationContent,
  notificationContent,
} from '../notifications/notification.policy';
import { EmailQueueService } from '../common/queues/email/email.queue';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import AppError from '../common/errors/app.error';
import * as bcrypt from 'bcryptjs';
import { TokenVersionCache } from '../infrastructure/token-version/token-version.cache';
import { ILoginResponse, UserRole } from './interfaces/auth.interface';
import { AuthChallengeRepository } from './state/auth-challenge.repository';
import { storeLoginSession } from './state/login-session';
import {
  RefreshSessionRepository,
  type StoredRefreshSession,
} from './state/refresh-session.repository';

/** Raised inside the verification transaction for an already verified user. */
class EmailAlreadyVerifiedError extends Error {}

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

@Injectable()
export class AuthService {
  constructor(
    private readonly authUtilsService: AuthUtilsService,
    private readonly prismaService: PrismaService,
    private readonly activityLogService: ActivityLogService,
    private readonly sessions: RefreshSessionRepository,
    private readonly challenges: AuthChallengeRepository,
    private readonly tokenVersions: TokenVersionCache,
    private readonly emailQueueService: EmailQueueService,
    private readonly customLogger: CustomLoggerService,
    private readonly referrals: ReferralRegistrationService,
    private readonly notifications: NotificationService,
  ) {}

  async create(
    payload: CreateAuthDto,
    meta: { ip: string; userAgent: string; device?: string },
  ): Promise<void> {
    const { email, password, username } = payload;
    const { ip, userAgent, device } = meta;

    this.customLogger.log(
      `Registration attempt for email: ${email}, username: ${username}`,
      'AuthService',
    );

    const { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS } = AUTH_CONFIG.RATE_LIMIT;
    const { VERIFICATION } = AUTH_CONFIG.TOKEN_EXPIRY;

    // Check rate limiting for email, IP, and user agent
    await Promise.all([
      this.authUtilsService.checkRateLimit(
        `login:email:${email}`,
        LOGIN_MAX_ATTEMPTS,
        LOGIN_WINDOW_MS,
      ),
      this.authUtilsService.checkRateLimit(
        `login:ip:${ip}`,
        LOGIN_MAX_ATTEMPTS,
        LOGIN_WINDOW_MS,
      ),
    ]);

    // Validate password length
    if (!this.authUtilsService.validatePassword(password)) {
      throw AppError.badRequest('Password must be at least 6 characters');
    }

    // Check if user already exists with email or username
    const existingUser = await this.prismaService.authUser.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
    });

    if (existingUser) {
      if (existingUser.email === email) {
        this.customLogger.warn(
          `Registration failed: Email already exists - ${email}`,
          'AuthService',
        );
        throw AppError.conflict('Email already exists!');
      }
      if (existingUser.username === username) {
        this.customLogger.warn(
          `Registration failed: Username already exists - ${username}`,
          'AuthService',
        );
        throw AppError.conflict('Username already exists!');
      }
    }

    // A referral code is checked before anything is created; an invalid,
    // own or duplicate referral refuses the registration.
    if (payload.referralCode !== undefined) {
      await this.referrals.assertUsableAtSignup(payload.referralCode, email);
    }

    // Generate verification code
    const verificationCode = this.authUtilsService.generateVerificationCode();
    const expiresAt = new Date(
      Date.now() + this.parseExpiryToSeconds(VERIFICATION) * 1000,
    );

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create user with auth security in a transaction
    const newUser = await this.prismaService.$transaction(
      async (tx): Promise<{ id: string; email: string; username: string }> => {
        // Create auth user
        const user = await tx.authUser.create({
          data: {
            email,
            username,
            password: hashedPassword,
            role: 'USER',
            verified: false,
            status: 'ACTIVE',
            provider: 'local',
          },
        });

        // Create auth security record
        await tx.authSecurity.create({
          data: {
            authId: user.id,
            failedAttempts: 0,
            mfaEnabled: false,
            lastPasswordChange: new Date(),
          },
        });

        // The referral is registered with the account, in this transaction
        // (checked again under the transaction).
        if (payload.referralCode !== undefined) {
          await this.referrals.registerAtSignup(tx, {
            authId: user.id,
            email,
            code: payload.referralCode,
          });
        }

        // Log user registration activity
        await this.activityLogService.logCreate(
          'authUser',
          user.id,
          {
            email,
            username,
            role: 'USER',
            status: 'ACTIVE',
            verified: 'false',
            provider: 'local',
          },
          { ip, userAgent, actionedBy: user.id, device },
          tx,
        );

        // Store the verification code (hashed) with the account
        await this.challenges.issue(
          user.id,
          'EMAIL_VERIFICATION',
          verificationCode,
          {
            expiresAt,
            maxAttempts: AUTH_CONFIG.VERIFICATION_CODE_MAX_ATTEMPTS,
          },
          tx,
        );

        return user;
      },
    );

    // Record the verification email (its delivery history) and queue it.
    try {
      await this.emailQueueService.sendVerificationEmail(
        email,
        username,
        verificationCode,
        newUser.id,
        { ipAddress: ip, userAgent },
      );
      this.customLogger.log(
        `User registered successfully: ${email}, verification email queued`,
        'AuthService',
      );
    } catch (error) {
      this.customLogger.error(
        `Failed to queue verification email for ${email}`,
        error instanceof Error ? error.stack : undefined,
        'AuthService',
      );
      // The user is created; they can request the code again.
    }
  }

  /**
   * Verify user email with verification code
   */
  async verifyEmail(
    email: string,
    code: string,
    meta: { ip: string; userAgent: string },
  ): Promise<{ message: string }> {
    const { ip, userAgent } = meta;

    this.customLogger.log(
      `Email verification attempt for: ${email}`,
      'AuthService',
    );
    const expiredError = AppError.badRequest(
      'Verification code expired or invalid. Please request a new code.',
    );

    // The code belongs to the account registered with this email
    const user = await this.prismaService.authUser.findUnique({
      where: { email },
    });

    if (!user) {
      this.customLogger.warn(
        `Verification failed: Code expired or invalid for ${email}`,
        'AuthService',
      );
      throw expiredError;
    }

    // Check (and count) the code; a matching code is consumed in the same
    // transaction that marks the email as verified
    let check: Awaited<ReturnType<AuthChallengeRepository['verify']>>;
    try {
      check = await this.challenges.verify(
        user.id,
        'EMAIL_VERIFICATION',
        code,
        {
          onValid: async (tx) => {
            const verified = await tx.authUser.updateMany({
              where: { id: user.id, verified: false },
              data: { verified: true },
            });
            if (!verified.count) throw new EmailAlreadyVerifiedError();

            // Log verification activity
            await this.activityLogService.logCustomEvent(
              'authUser',
              user.id,
              'profile_update',
              { ip, userAgent, actionedBy: user.id },
              [
                {
                  fieldName: 'verified',
                  oldValue: 'false',
                  newValue: 'true',
                },
              ],
              tx,
            );
          },
        },
      );
    } catch (error) {
      if (error instanceof EmailAlreadyVerifiedError) {
        throw AppError.badRequest('Email already verified');
      }
      throw error;
    }

    if (check === 'EXPIRED') {
      this.customLogger.warn(
        `Verification failed: Code expired or invalid for ${email}`,
        'AuthService',
      );
      throw expiredError;
    }

    if (check === 'INVALID') {
      this.customLogger.warn(
        `Verification failed: Invalid code for ${email}`,
        'AuthService',
      );
      throw AppError.badRequest('Invalid verification code');
    }

    // Queue welcome email for async processing
    try {
      await this.emailQueueService.sendWelcomeEmail(
        email,
        user.username,
        user.id,
      );
      this.customLogger.log(
        `Email verified successfully for: ${email}, welcome email queued`,
        'AuthService',
      );
    } catch (error) {
      this.customLogger.error(
        `Verification successful but failed to queue welcome email for ${email}`,
        error instanceof Error ? error.stack : undefined,
        'AuthService',
      );
      console.error('Failed to queue welcome email:', error);
      // Don't throw, verification is successful
    }

    return { message: 'Email verified successfully' };
  }

  /**
   * Resend verification email
   */
  async resendVerificationEmail(
    email: string,
    meta: { ip: string; userAgent: string },
  ): Promise<{ message: string }> {
    const { ip, userAgent } = meta;
    const { VERIFICATION } = AUTH_CONFIG.TOKEN_EXPIRY;

    this.customLogger.log(
      `Resend verification email requested for: ${email}`,
      'AuthService',
    );

    // Check rate limiting
    await this.authUtilsService.checkRateLimit(
      `resend:verification:${email}`,
      3, // Max 3 attempts
      15 * 60 * 1000, // 15 minutes
    );

    // Find user
    const user = await this.prismaService.authUser.findUnique({
      where: { email },
    });

    if (!user) {
      throw AppError.notFound('User not found');
    }

    if (user.verified) {
      throw AppError.badRequest('Email already verified');
    }

    // Generate new verification code
    const verificationCode = this.authUtilsService.generateVerificationCode();
    const expiresAt = new Date(
      Date.now() + this.parseExpiryToSeconds(VERIFICATION) * 1000,
    );

    // Store the new verification code (hashed); it replaces the previous one
    await this.challenges.issue(
      user.id,
      'EMAIL_VERIFICATION',
      verificationCode,
      {
        expiresAt,
        maxAttempts: AUTH_CONFIG.VERIFICATION_CODE_MAX_ATTEMPTS,
      },
    );

    // Record the verification email (its delivery history) and queue it.
    try {
      await this.emailQueueService.sendVerificationEmail(
        email,
        user.username,
        verificationCode,
        user.id,
        { ipAddress: ip, userAgent },
      );
    } catch (error) {
      this.customLogger.error(
        'Failed to record the verification email',
        error instanceof Error ? error.stack : undefined,
        'AuthService',
      );
      throw AppError.badRequest('Failed to send verification email');
    }

    return { message: 'Verification email sent successfully' };
  }

  async login(
    payload: { email: string; password: string },
    meta: { ip: string; userAgent: string; device?: string },
  ): Promise<ILoginResponse> {
    const { email, password } = payload;
    const { ip, userAgent, device } = meta;

    const { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS } = AUTH_CONFIG.RATE_LIMIT;
    const { MAX_FAILED_ATTEMPTS, LOCKOUT_DURATION_MS } =
      AUTH_CONFIG.ACCOUNT_LOCKOUT;

    // Rate limiting
    await Promise.all([
      this.authUtilsService.checkRateLimit(
        `login:email:${email}`,
        LOGIN_MAX_ATTEMPTS,
        LOGIN_WINDOW_MS,
      ),
      this.authUtilsService.checkRateLimit(
        `login:ip:${ip}`,
        LOGIN_MAX_ATTEMPTS,
        LOGIN_WINDOW_MS,
      ),
    ]);

    // Fetch user with security data in single optimized query
    const user = await this.prismaService.authUser.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        username: true,
        password: true,
        role: true,
        verified: true,
        status: true,
        provider: true,
        tokenVersion: true,
        authSecurity: {
          select: {
            id: true,
            failedAttempts: true,
            lastFailedAt: true,
            lockExpiresAt: true,
          },
        },
      },
    });

    // Generic error message to prevent user enumeration
    const invalidCredentialsError = AppError.unauthorized(
      'Invalid email or password',
    );

    // CRITICAL: Timing attack prevention
    // Always run bcrypt.compare even if user doesn't exist
    // This ensures consistent response time regardless of user existence
    const fakePasswordHash =
      '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.G4.4.G4.G4.G4.G';

    if (!user) {
      // Run fake bcrypt to prevent timing attacks (~200ms)
      await bcrypt.compare(password, fakePasswordHash);

      // Log failed attempt (fire-and-forget)
      void this.logLoginAttempt({
        authId: null,
        ip,
        userAgent,
        device,
        success: false,
        failureReason: 'user_not_found',
      });

      throw invalidCredentialsError;
    }

    // Check OAuth provider
    if (user.provider !== 'local') {
      throw AppError.badRequest(
        `Please login using ${user.provider} authentication`,
      );
    }

    // Check account status
    if (user.status === 'BLOCKED' || user.status === 'SUSPENDED') {
      void this.logLoginAttempt({
        authId: user.id,
        ip,
        userAgent,
        device,
        success: false,
        failureReason: `account_${user.status.toLowerCase()}`,
      });
      throw AppError.forbidden(
        `Your account has been ${user.status.toLowerCase()}. Please contact support.`,
      );
    }

    // Any other non-active state (DELETED, INACTIVE, PENDING_DELETION, or a
    // future status) must never receive tokens.
    if (user.status !== 'ACTIVE') {
      // Run bcrypt to maintain consistent timing
      await bcrypt.compare(password, user.password);
      throw invalidCredentialsError;
    }

    // Check account lockout
    const security = user.authSecurity;
    if (security?.lockExpiresAt && new Date() < security.lockExpiresAt) {
      const remainingTime = Math.ceil(
        (security.lockExpiresAt.getTime() - Date.now()) / 1000 / 60,
      );
      void this.logLoginAttempt({
        authId: user.id,
        ip,
        userAgent,
        device,
        success: false,
        failureReason: 'account_locked',
        attemptNumber: security.failedAttempts + 1,
      });
      throw AppError.forbidden(
        `Account is temporarily locked. Please try again in ${remainingTime} minutes.`,
      );
    }

    // Verify password (bcrypt uses constant-time comparison internally)
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      await this.handleFailedLoginAttempt(
        user.id,
        security?.failedAttempts || 0,
        MAX_FAILED_ATTEMPTS,
        LOCKOUT_DURATION_MS,
        { ip, userAgent, device },
      );
      throw invalidCredentialsError;
    }

    // Check email verification
    if (!user.verified) {
      void this.logLoginAttempt({
        authId: user.id,
        ip,
        userAgent,
        device,
        success: false,
        failureReason: 'email_not_verified',
      });
      throw AppError.forbidden(
        'Please verify your email address before logging in',
      );
    }

    // Generate JTI FIRST (cryptographically secure)
    const jti: string = this.authUtilsService.generateSecureId();

    // Create access token (stateless, minimal payload - no email)
    const accessToken: string = this.authUtilsService.createAccessToken({
      userId: user.id,
      role: user.role as unknown as UserRole,
      tokenVersion: user.tokenVersion, // Include tokenVersion for hybrid JWT validation
    });

    // Create refresh token with JTI embedded
    const refreshToken: string = this.authUtilsService.createRefreshToken(
      { userId: user.id },
      jti,
    );

    // CRITICAL: Store the refresh session (hash only, never the raw token).
    // A per-user lock rejects a concurrent login of the same user, and the
    // oldest sessions beyond the device limit are revoked in the same
    // transaction.
    await storeLoginSession(
      this.sessions,
      this.authUtilsService,
      user.id,
      jti,
      refreshToken,
      { ip, userAgent, device },
    );

    // NON-CRITICAL: DB operations (fire-and-forget with detailed logging)
    void Promise.allSettled([
      security
        ? this.prismaService.authSecurity.update({
            where: { id: security.id },
            data: {
              failedAttempts: 0,
              lastFailedAt: null,
              lockExpiresAt: null,
            },
          })
        : Promise.resolve(),
      this.logLoginAttempt({
        authId: user.id,
        ip,
        userAgent,
        device,
        success: true,
      }),
    ]).then((results) => {
      results.forEach((result) => {
        if (result.status === 'rejected') {
          console.error('Non-critical login post-process failed:', result);
        }
      });
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        verified: user.verified,
      },
      expiresIn: this.parseExpiryToSeconds(AUTH_CONFIG.TOKEN_EXPIRY.ACCESS),
    };
  }

  /**
   * Refresh access token using refresh token
   * Implements token rotation for security
   */
  async refreshToken(
    refreshToken: string,
    meta: { ip: string; userAgent: string; device?: string },
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const { ip, userAgent, device } = meta;

    // Verify and decode refresh token
    let decoded: { userId: string; jti: string };
    try {
      const payload = this.authUtilsService.verifyRefreshToken(refreshToken);

      // JTI comes from JWT standard claims (set via jwtid option)
      if (!payload.jti) {
        throw new Error('Missing JTI in token');
      }

      decoded = {
        userId: payload.userId,
        jti: payload.jti,
      };
    } catch {
      throw AppError.unauthorized('Invalid or expired refresh token');
    }

    const { userId, jti } = decoded;
    if (!userId || !jti) {
      throw AppError.unauthorized('Invalid refresh token payload');
    }

    // Get the stored session
    let storedData: StoredRefreshSession | null;
    try {
      storedData = await this.sessions.find(jti);
    } catch {
      throw AppError.serviceUnavailable(
        'Authentication is temporarily unavailable',
      );
    }

    if (
      !storedData ||
      storedData.authId !== userId ||
      storedData.revokedAt !== null ||
      storedData.expiresAt.getTime() <= Date.now()
    ) {
      // A concurrent request may already have rotated it. Reject this token,
      // without revoking the successful request's replacement or other devices.
      throw AppError.unauthorized(
        'Refresh token has been revoked. Please login again.',
      );
    }

    // Validate token hash (ensures token hasn't been tampered with)
    const tokenHash: string = this.authUtilsService.hashToken(refreshToken);
    if (storedData.tokenHash !== tokenHash) {
      // Token mismatch - potential attack, revoke all tokens
      await this.revokeAllUserTokens(userId, 'REUSE_DETECTED');
      // Security notification (always emailed), once per reused session.
      await this.notifySecurityEvent(
        userId,
        `security:session-reuse:${jti}`,
        notificationContent.sessionReuseDetected(),
      );
      throw AppError.unauthorized('Invalid refresh token');
    }

    // Fetch user to get current role (may have changed)
    const user = await this.prismaService.authUser.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true, tokenVersion: true },
    });

    if (!user || user.status !== 'ACTIVE') {
      await this.revokeAllUserTokens(userId, 'ACCOUNT_INACTIVE');
      throw AppError.unauthorized('User account is not active');
    }

    // TOKEN ROTATION: Generate new JTI for new refresh token
    const newJti: string = this.authUtilsService.generateSecureId();

    // Create new tokens
    const newAccessToken: string = this.authUtilsService.createAccessToken({
      userId: user.id,
      role: user.role as unknown as UserRole,
      tokenVersion: user.tokenVersion, // Include tokenVersion for hybrid JWT validation
    });

    const newRefreshToken: string = this.authUtilsService.createRefreshToken(
      { userId: user.id },
      newJti,
    );

    const refreshTokenTTL = this.parseExpiryToSeconds(
      AUTH_CONFIG.TOKEN_EXPIRY.REFRESH,
    );

    // Revoke the presented session and store its replacement atomically:
    // of concurrent requests with the same token, only one succeeds.
    let rotated: boolean;
    try {
      rotated = await this.sessions.rotate(
        { authId: userId, tokenId: jti, tokenHash },
        {
          authId: userId,
          tokenId: newJti,
          tokenHash: this.authUtilsService.hashToken(newRefreshToken),
          ipAddress: ip,
          userAgent,
          device,
          expiresAt: new Date(Date.now() + refreshTokenTTL * 1000),
        },
      );
    } catch {
      throw AppError.serviceUnavailable(
        'Authentication is temporarily unavailable',
      );
    }
    if (!rotated)
      throw AppError.unauthorized(
        'Refresh token has already been used or revoked',
      );

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: this.parseExpiryToSeconds(AUTH_CONFIG.TOKEN_EXPIRY.ACCESS),
    };
  }

  /**
   * Logout user by revoking their refresh token
   */
  async logout(
    refreshToken: string,
    userId: string,
  ): Promise<{ message: string }> {
    // Verify refresh token
    let decoded;
    try {
      decoded = this.authUtilsService.verifyRefreshToken(refreshToken);
    } catch {
      // Token already invalid, just return success
      return { message: 'Logged out successfully' };
    }

    if (decoded.userId !== userId) {
      throw AppError.unauthorized('Invalid token');
    }

    const { jti } = decoded;
    if (jti) {
      await this.sessions.revoke(userId, jti, 'LOGOUT');
    }

    return { message: 'Logged out successfully' };
  }

  /**
   * Logout from all devices by revoking all refresh tokens
   */
  async logoutAllDevices(userId: string): Promise<{ message: string }> {
    await this.revokeAllUserTokens(userId, 'LOGOUT_ALL');
    // Increment tokenVersion to immediately invalidate all access tokens
    await this.incrementTokenVersion(userId);
    // Security notification (always emailed), one per sign-out (the new
    // token version identifies it).
    const user = await this.prismaService.authUser.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    if (user) {
      await this.notifySecurityEvent(
        userId,
        `security:signed-out-everywhere:v${user.tokenVersion}`,
        notificationContent.signedOutEverywhere(),
      );
    }
    return { message: 'Logged out from all devices successfully' };
  }

  /**
   * Records a security notification (emailed whatever the preferences).
   * Best effort: the security action itself already happened and must not
   * fail because of its notification.
   */
  private async notifySecurityEvent(
    userId: string,
    eventKey: string,
    content: NotificationContent,
  ): Promise<void> {
    try {
      await this.notifications.notify(
        this.prismaService,
        userId,
        eventKey,
        content,
      );
    } catch (error) {
      this.customLogger.error(
        `Failed to record security notification ${content.type}`,
        error instanceof Error ? error.stack : undefined,
        'AuthService',
      );
    }
  }

  /**
   * Revoke all refresh tokens for a user (security measure)
   */
  private async revokeAllUserTokens(
    userId: string,
    reason:
      | 'LOGOUT_ALL'
      | 'REUSE_DETECTED'
      | 'ACCOUNT_INACTIVE'
      | 'SECURITY_EVENT',
  ): Promise<void> {
    await this.sessions.revokeAll(userId, reason);
  }

  /**
   * Revokes every session of a user after a security event that already
   * incremented the user's tokenVersion to `tokenVersion`: deletes all refresh
   * tokens and overwrites the cached token version (when a cache is
   * enabled), so access tokens issued before stop working at once. Throws
   * when either step cannot be confirmed, so callers can record the
   * revocation as pending and retry.
   */
  async revokeAllSessions(userId: string, tokenVersion: number): Promise<void> {
    await this.revokeAllUserTokens(userId, 'SECURITY_EVENT');
    await this.publishTokenVersion(userId, tokenVersion);
  }

  /**
   * Overwrites the cached token version, so every access token carrying an
   * older version is rejected by AuthGuard at once. Throws when the cache
   * cannot confirm the write, so callers can fail closed. Without a cache
   * (REDIS_ENABLED=false) AuthGuard reads the database, which is current.
   */
  async publishTokenVersion(
    userId: string,
    tokenVersion: number,
  ): Promise<void> {
    await this.tokenVersions.publish(userId, tokenVersion);
  }

  /**
   * Drops the cached token version so the next request reloads it from the
   * database (used to undo publishTokenVersion when its transaction failed).
   */
  async forgetCachedTokenVersion(userId: string): Promise<void> {
    await this.tokenVersions.invalidate(userId);
  }

  /**
   * Removes short-lived authentication data of a deleted account: sessions
   * and codes (also removed with the account's rows), the cached token
   * version (set to 0, which matches no token) and the rate limits keyed by
   * the email address. Best effort: everything also expires on its own.
   */
  async forgetDeletedAccount(userId: string, email: string | null) {
    await this.revokeAllUserTokens(userId, 'SECURITY_EVENT').catch(
      () => undefined,
    );
    await this.challenges.remove(userId).catch(() => undefined);
    await this.tokenVersions.publish(userId, 0).catch(() => undefined);
    if (email) {
      await this.authUtilsService
        .resetRateLimit(`login:email:${email}`)
        .catch(() => undefined);
    }
  }

  /**
   * Counts a wrong password entered by a signed-in user to confirm a
   * sensitive action (for example account deletion) toward the same lockout
   * as failed logins; reaching the lockout also revokes the user's tokens.
   */
  async recordFailedPasswordConfirmation(
    userId: string,
    currentFailedAttempts: number,
    meta: { ip: string; userAgent: string; device?: string },
  ): Promise<void> {
    const { MAX_FAILED_ATTEMPTS, LOCKOUT_DURATION_MS } =
      AUTH_CONFIG.ACCOUNT_LOCKOUT;
    await this.handleFailedLoginAttempt(
      userId,
      currentFailedAttempts,
      MAX_FAILED_ATTEMPTS,
      LOCKOUT_DURATION_MS,
      meta,
    );
  }

  /**
   * Handle failed login attempt with account lockout
   */
  private async handleFailedLoginAttempt(
    userId: string,
    currentFailedAttempts: number,
    maxAttempts: number,
    lockoutDuration: number,
    meta: { ip: string; userAgent: string; device?: string },
  ): Promise<void> {
    const newFailedAttempts = currentFailedAttempts + 1;
    const shouldLock = newFailedAttempts >= maxAttempts;

    await Promise.all([
      this.prismaService.authSecurity.update({
        where: { authId: userId },
        data: {
          failedAttempts: newFailedAttempts,
          lastFailedAt: new Date(),
          ...(shouldLock && {
            lockExpiresAt: new Date(Date.now() + lockoutDuration),
          }),
        },
      }),
      this.logLoginAttempt({
        authId: userId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        device: meta.device,
        success: false,
        failureReason: shouldLock ? 'account_locked' : 'invalid_password',
        attemptNumber: newFailedAttempts,
      }),
    ]);

    // On account lock, increment tokenVersion to immediately invalidate all access tokens
    if (shouldLock) {
      await this.incrementTokenVersion(userId);
    }
  }

  /**
   * Log login attempt (fire-and-forget for non-blocking writes)
   */
  private logLoginAttempt(data: {
    authId: string | null;
    ip: string;
    userAgent: string;
    device?: string;
    success: boolean;
    failureReason?: string;
    attemptNumber?: number;
    isSuspicious?: boolean;
  }): Promise<void> {
    if (!data.authId) {
      return Promise.resolve();
    }

    return this.prismaService.loginHistory
      .create({
        data: {
          authId: data.authId,
          ipAddress: data.ip,
          userAgent: data.userAgent,
          device_id: data.device,
          action: 'login',
          success: data.success,
          failureReason: data.failureReason,
          attemptNumber: data.attemptNumber || 1,
          isSuspicious: data.isSuspicious || false,
        },
      })
      .then(() => undefined)
      .catch((error) => {
        console.error('Failed to log login attempt:', error);
      });
  }

  /**
   * Parse token expiry string to seconds
   */
  private parseExpiryToSeconds(expiry: string): number {
    const match = expiry.match(/^(\d+)([smhd])?$/);
    if (!match) {
      return 3600;
    }

    const value = parseInt(match[1], 10);
    const unit = match[2] || 's';

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 60 * 60;
      case 'd':
        return value * 60 * 60 * 24;
      default:
        return value;
    }
  }

  /**
   * Increment token version for a user to immediately invalidate all access tokens.
   * Called on security-critical events: password change, role change, admin block, force logout.
   * Clears the token-version cache so AuthGuard fetches the new version from DB.
   *
   * @param userId - The user whose token version to increment
   */
  async incrementTokenVersion(userId: string): Promise<void> {
    // Increment in database
    await this.prismaService.authUser.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });

    // Invalidate the cache so the next guard check fetches the new version
    await this.tokenVersions.invalidate(userId);

    this.customLogger.log(`Token version incremented for user ${userId}, {
      context: 'AuthService.incrementTokenVersion',
      userId,
    }`);
  }
}
