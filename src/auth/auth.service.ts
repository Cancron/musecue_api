import { Injectable } from '@nestjs/common';
import { CreateAuthDto } from './dto/create-auth.dto';
import { AuthUtilsService } from './services/auth-utils.service';
import { AUTH_CONFIG } from './config/auth.config';
import { PrismaService } from '../common/services/prisma.service';
import { ActivityLogService } from '../common/services/activity-log.service';
import { RedisService } from '../common/services/redis.service';
import { EmailQueueService } from '../common/queues/email/email.queue';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import AppError from '../common/errors/app.error';
import * as bcrypt from 'bcryptjs';
import config from '../common/config/app.config';
import {
  ILoginResponse,
  IStoredRefreshToken,
  UserRole,
} from './interfaces/auth.interface';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

@Injectable()
export class AuthService {
  constructor(
    private readonly authUtilsService: AuthUtilsService,
    private readonly prismaService: PrismaService,
    private readonly activityLogService: ActivityLogService,
    private readonly redisService: RedisService,
    private readonly emailQueueService: EmailQueueService,
    private readonly customLogger: CustomLoggerService,
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

    // Generate verification code
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

        // Create email history record for verification email
        await tx.emailHistory.create({
          data: {
            authId: user.id,
            emailTo: email,
            emailType: 'verification',
            subject: 'Verify your email address',
            messageId: `verify-${user.id}-${Date.now()}`,
            emailStatus: 'pending',
            ipAddress: ip,
            userAgent: userAgent,
          },
        });

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

        return user;
      },
    );

    // Store verification code in Redis with expiry
    const verificationKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.VERIFICATION_TOKEN}:${email}`;
    const ttlSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);

    await this.redisService.set(
      verificationKey,
      {
        code: verificationCode,
        userId: newUser.id,
        email: newUser.email,
        expiresAt: expiresAt.toISOString(),
      },
      ttlSeconds,
    );

    // Queue verification email for async processing
    try {
      await this.emailQueueService.sendVerificationEmail(
        email,
        username,
        verificationCode,
        newUser.id,
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
      console.error('Failed to queue verification email:', error);
      // Update email history status to 'failed'
      await this.prismaService.emailHistory.updateMany({
        where: {
          authId: newUser.id,
          emailType: 'verification',
          emailStatus: 'pending',
        },
        data: {
          emailStatus: 'failed',
          errorMessage:
            error instanceof Error ? error.message : 'Failed to queue email',
        },
      });
      // Don't throw error, user is created, just email failed
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
    const verificationKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.VERIFICATION_TOKEN}:${email}`;

    // Get verification data from Redis
    const verificationData = await this.redisService.get<{
      code: string;
      userId: string;
      email: string;
      expiresAt: string;
    }>(verificationKey);

    if (!verificationData) {
      this.customLogger.warn(
        `Verification failed: Code expired or invalid for ${email}`,
        'AuthService',
      );
      throw AppError.badRequest(
        'Verification code expired or invalid. Please request a new code.',
      );
    }

    // Validate code
    if (verificationData.code !== code) {
      this.customLogger.warn(
        `Verification failed: Invalid code for ${email}`,
        'AuthService',
      );
      throw AppError.badRequest('Invalid verification code');
    }

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

    // Update user as verified
    await this.prismaService.$transaction(async (tx) => {
      await tx.authUser.update({
        where: { id: user.id },
        data: { verified: true },
      });

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
    });

    // Delete verification code from Redis
    await this.redisService.del(verificationKey);

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

    // Store new verification code in Redis
    const verificationKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.VERIFICATION_TOKEN}:${email}`;
    const ttlSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);

    await this.redisService.set(
      verificationKey,
      {
        code: verificationCode,
        userId: user.id,
        email: user.email,
        expiresAt: expiresAt.toISOString(),
      },
      ttlSeconds,
    );

    // Create new email history record
    await this.prismaService.emailHistory.create({
      data: {
        authId: user.id,
        emailTo: email,
        emailType: 'verification',
        subject: 'Verify your email address',
        messageId: `verify-resend-${user.id}-${Date.now()}`,
        emailStatus: 'pending',
        ipAddress: ip,
        userAgent: userAgent,
      },
    });

    // Queue verification email for async processing
    try {
      await this.emailQueueService.sendVerificationEmail(
        email,
        user.username,
        verificationCode,
        user.id,
      );
    } catch (error) {
      console.error('Failed to queue verification email:', error);
      // Update email history status to 'failed'
      await this.prismaService.emailHistory.updateMany({
        where: {
          authId: user.id,
          emailType: 'verification',
          emailStatus: 'pending',
        },
        data: {
          emailStatus: 'failed',
          errorMessage:
            error instanceof Error ? error.message : 'Failed to queue email',
        },
      });
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

    if (user.status === 'DELETED' || user.status === 'INACTIVE') {
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

    // Distributed lock to prevent concurrent login race conditions
    const lockKey = `${config.redis_cache_key_prefix}:lock:login:${user.id}`;
    const lockAcquired = await this.redisService.setNX(lockKey, '1', 5); // 5 second TTL

    if (!lockAcquired) {
      throw AppError.conflict(
        'Another login is in progress. Please try again in a moment.',
      );
    }

    try {
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

      // Hash the refresh token for secure storage (never store raw tokens)
      const tokenHash: string = this.authUtilsService.hashToken(refreshToken);

      // Calculate TTL
      const refreshTokenTTL = this.parseExpiryToSeconds(
        AUTH_CONFIG.TOKEN_EXPIRY.REFRESH,
      );

      // Redis key with proper naming convention
      const refreshTokenKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.REFRESH_TOKEN}:${user.id}:${jti}`;

      // Stored token data (with hash, not raw token)
      const storedTokenData: IStoredRefreshToken = {
        userId: user.id,
        jti,
        tokenHash, // Store hash, not raw token
        ip,
        userAgent,
        device,
        createdAt: new Date().toISOString(),
      };

      // Execute critical Redis operations with detailed error handling and rollback
      try {
        // CRITICAL: Store refresh token hash in Redis
        await this.redisService.set(
          refreshTokenKey,
          storedTokenData,
          refreshTokenTTL,
        );
      } catch (error) {
        console.error('Failed to store refresh token in Redis:', {
          userId: user.id,
          jti,
          error: error instanceof Error ? error.message : String(error),
        });
        throw AppError.serviceUnavailable(
          'Authentication service temporarily unavailable. Please try again.',
        );
      }

      try {
        // CRITICAL: Track session in user's session list
        await this.addUserSession(user.id, jti, refreshTokenTTL);
      } catch (error) {
        console.error('Failed to add user session to Redis:', {
          userId: user.id,
          jti,
          error: error instanceof Error ? error.message : String(error),
        });

        // Rollback: Remove the refresh token we just stored
        await this.redisService.del(refreshTokenKey).catch((rollbackError) => {
          console.error('CRITICAL: Failed to rollback refresh token:', {
            userId: user.id,
            jti,
            error:
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
          });
        });

        throw AppError.serviceUnavailable(
          'Authentication service temporarily unavailable. Please try again.',
        );
      }

      // NON-CRITICAL: Enforce max devices (log but don't fail login)
      try {
        await this.enforceMaxDevices(
          user.id,
          AUTH_CONFIG.SESSION.MAX_DEVICES_PER_USER,
        );
      } catch (error) {
        console.error('Failed to enforce max devices (non-critical):', {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue - login still succeeds
      }

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
    } finally {
      // Always release the lock
      await this.redisService.del(lockKey);
    }
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

    // Get stored token data from Redis
    const refreshTokenKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.REFRESH_TOKEN}:${userId}:${jti}`;
    const storedData =
      await this.redisService.get<IStoredRefreshToken>(refreshTokenKey);

    if (!storedData) {
      // Token not found - possibly already rotated or revoked
      // This could indicate a replay attack - revoke all user tokens
      await this.revokeAllUserTokens(userId);
      throw AppError.unauthorized(
        'Refresh token has been revoked. Please login again.',
      );
    }

    // Validate token hash (ensures token hasn't been tampered with)
    const tokenHash: string = this.authUtilsService.hashToken(refreshToken);
    if (storedData.tokenHash !== tokenHash) {
      // Token mismatch - potential attack, revoke all tokens
      await this.revokeAllUserTokens(userId);
      throw AppError.unauthorized('Invalid refresh token');
    }

    // Fetch user to get current role (may have changed)
    const user = await this.prismaService.authUser.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true, tokenVersion: true },
    });

    if (!user || user.status !== 'ACTIVE') {
      await this.revokeAllUserTokens(userId);
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

    const newTokenHash: string =
      this.authUtilsService.hashToken(newRefreshToken);
    const refreshTokenTTL = this.parseExpiryToSeconds(
      AUTH_CONFIG.TOKEN_EXPIRY.REFRESH,
    );

    const newRefreshTokenKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.REFRESH_TOKEN}:${userId}:${newJti}`;

    const newStoredData: IStoredRefreshToken = {
      userId,
      jti: newJti,
      tokenHash: newTokenHash,
      ip,
      userAgent,
      device,
      createdAt: new Date().toISOString(),
      rotatedFrom: jti, // Track rotation chain
    };

    // Atomic rotation: delete old token and create new one
    await Promise.all([
      // Delete old refresh token
      this.redisService.del(refreshTokenKey),
      // Remove old JTI from session list
      this.removeUserSession(userId, jti),
      // Store new refresh token
      this.redisService.set(newRefreshTokenKey, newStoredData, refreshTokenTTL),
      // Add new JTI to session list
      this.addUserSession(userId, newJti, refreshTokenTTL),
    ]);

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
      const refreshTokenKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.REFRESH_TOKEN}:${userId}:${jti}`;

      await Promise.all([
        this.redisService.del(refreshTokenKey),
        this.removeUserSession(userId, jti),
      ]);
    }

    return { message: 'Logged out successfully' };
  }

  /**
   * Logout from all devices by revoking all refresh tokens
   */
  async logoutAllDevices(userId: string): Promise<{ message: string }> {
    await this.revokeAllUserTokens(userId);
    // Increment tokenVersion to immediately invalidate all access tokens
    await this.incrementTokenVersion(userId);
    return { message: 'Logged out from all devices successfully' };
  }

  /**
   * Add a session (JTI) to user's session list
   */
  private async addUserSession(
    userId: string,
    jti: string,
    ttl: number,
  ): Promise<void> {
    const userSessionsKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.USER_SESSIONS}:${userId}`;

    // Get current sessions
    const sessions =
      (await this.redisService.get<string[]>(userSessionsKey)) || [];

    // Add new session
    sessions.push(jti);

    // Store updated sessions
    await this.redisService.set(userSessionsKey, sessions, ttl);
  }

  /**
   * Remove a session from user's session list
   */
  private async removeUserSession(userId: string, jti: string): Promise<void> {
    const userSessionsKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.USER_SESSIONS}:${userId}`;

    const sessions =
      (await this.redisService.get<string[]>(userSessionsKey)) || [];
    const updatedSessions = sessions.filter((s) => s !== jti);

    if (updatedSessions.length > 0) {
      const ttl = this.parseExpiryToSeconds(AUTH_CONFIG.TOKEN_EXPIRY.REFRESH);
      await this.redisService.set(userSessionsKey, updatedSessions, ttl);
    } else {
      await this.redisService.del(userSessionsKey);
    }
  }

  /**
   * Enforce maximum devices per user
   * Removes oldest sessions when limit exceeded
   */
  private async enforceMaxDevices(
    userId: string,
    maxDevices: number,
  ): Promise<void> {
    const userSessionsKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.USER_SESSIONS}:${userId}`;

    const sessions =
      (await this.redisService.get<string[]>(userSessionsKey)) || [];

    if (sessions.length <= maxDevices) {
      return;
    }

    // Remove oldest sessions (first in list)
    const sessionsToRemove = sessions.slice(
      0,
      sessions.length - maxDevices + 1,
    );

    await Promise.all(
      sessionsToRemove.map(async (jti) => {
        const tokenKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.REFRESH_TOKEN}:${userId}:${jti}`;
        await this.redisService.del(tokenKey);
      }),
    );

    // Keep only the most recent sessions
    const updatedSessions = sessions.slice(sessions.length - maxDevices + 1);
    const ttl = this.parseExpiryToSeconds(AUTH_CONFIG.TOKEN_EXPIRY.REFRESH);
    await this.redisService.set(userSessionsKey, updatedSessions, ttl);
  }

  /**
   * Revoke all refresh tokens for a user (security measure)
   */
  private async revokeAllUserTokens(userId: string): Promise<void> {
    const userSessionsKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.USER_SESSIONS}:${userId}`;

    const sessions =
      (await this.redisService.get<string[]>(userSessionsKey)) || [];

    // Delete all refresh tokens
    await Promise.all([
      ...sessions.map((jti) => {
        const tokenKey = `${config.redis_cache_key_prefix}:${AUTH_CONFIG.CACHE_PREFIXES.REFRESH_TOKEN}:${userId}:${jti}`;
        return this.redisService.del(tokenKey);
      }),
      this.redisService.del(userSessionsKey),
    ]);
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
   * Clears Redis cache to ensure AuthGuard will fetch new version from DB.
   *
   * @param userId - The user whose token version to increment
   */
  async incrementTokenVersion(userId: string): Promise<void> {
    // Increment in database
    await this.prismaService.authUser.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });

    // Invalidate Redis cache so next guard check fetches new version
    const cacheKey = `${config.redis_cache_key_prefix}:token_version:${userId}`;
    await this.redisService.del(cacheKey);

    this.customLogger.log(`Token version incremented for user ${userId}, {
      context: 'AuthService.incrementTokenVersion',
      userId,
    }`);
  }
}
