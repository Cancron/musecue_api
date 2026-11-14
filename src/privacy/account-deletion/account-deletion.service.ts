import { Inject, Injectable } from '@nestjs/common';
import type {
  AccountDeletionRequest,
  AccountDeletionVerification,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { AuthService } from '../../auth/auth.service';
import { AuthUtilsService } from '../../auth/services/auth-utils.service';
import AppError from '../../common/errors/app.error';
import { PrismaService } from '../../common/services/prisma.service';
import { AccountDeletionCodeService } from './account-deletion-code.service';
import {
  ACCOUNT_DELETION_CONFIRM_RATE_LIMIT,
  IDENTITY_VERIFICATION_FAILED,
} from './account-deletion.constants';
import type { RequestAccountDeletionDto } from './account-deletion.dto';
import type {
  AccountDeletionView,
  ConfirmationCodeView,
} from './account-deletion.interface';

export interface RequestMeta {
  ip: string;
  userAgent: string;
  device?: string;
}

const OPEN_STATUSES = ['PENDING', 'PROCESSING'] as const;

/** The token cache could not be updated, so the deletion is not approved. */
class TokenInvalidationUnavailableError extends Error {
  constructor() {
    super('Access tokens could not be invalidated');
    this.name = 'TokenInvalidationUnavailableError';
  }
}

/**
 * Accepts a signed-in user's request to permanently delete their own
 * account.
 *
 * The owner proves their identity again: accounts with a password send the
 * current password and a code emailed to the account's address; accounts
 * without a password (Google sign-in) send the emailed code. Accepting the
 * request blocks the account in the same transaction that records it
 * (status PENDING_DELETION and a new token version) and, before that
 * transaction commits, publishes the new token version to the token cache,
 * so no existing access token works once the deletion is approved (the
 * transaction rolls back if that is not possible). Refresh sessions are then
 * removed. Repeated or concurrent requests return the same open request: at
 * most one deletion per account can exist (database-enforced).
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly authUtils: AuthUtilsService,
    private readonly codes: AccountDeletionCodeService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /** Emails the one-time code that every deletion must be confirmed with. */
  async requestConfirmationCode(authId: string): Promise<ConfirmationCodeView> {
    const user = await this.prisma.authUser.findUnique({
      where: { id: authId },
      select: {
        id: true,
        email: true,
        username: true,
        status: true,
        provider: true,
      },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw AppError.unauthorized('User account is not active');
    }
    const { expiresAt } = await this.codes.issue(user);
    return {
      message: 'A confirmation code was sent to your email address',
      expiresAt: expiresAt.toISOString(),
    };
  }

  async requestDeletion(
    authId: string,
    dto: RequestAccountDeletionDto,
    meta: RequestMeta,
    now: Date = new Date(),
  ): Promise<AccountDeletionView> {
    await this.authUtils.checkRateLimit(
      `account_deletion:user:${authId}`,
      ACCOUNT_DELETION_CONFIRM_RATE_LIMIT.max,
      ACCOUNT_DELETION_CONFIRM_RATE_LIMIT.windowMs,
    );
    const user = await this.prisma.authUser.findUnique({
      where: { id: authId },
      select: {
        id: true,
        status: true,
        provider: true,
        password: true,
        authSecurity: {
          select: { failedAttempts: true, lockExpiresAt: true },
        },
      },
    });
    if (!user) throw AppError.unauthorized('User not found');

    const verificationMethod = await this.verifyIdentity(user, dto, meta, now);

    let accepted: { request: AccountDeletionRequest; tokenVersion: number };
    let tokenCachePublished = false;
    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        // Guarded transition: only an ACTIVE account can start a deletion.
        const blocked = await tx.authUser.updateMany({
          where: { id: authId, status: 'ACTIVE' },
          data: {
            status: 'PENDING_DELETION',
            tokenVersion: { increment: 1 },
          },
        });
        if (!blocked.count) return null;
        const { tokenVersion } = await tx.authUser.findUniqueOrThrow({
          where: { id: authId },
          select: { tokenVersion: true },
        });
        // Invalidate every access token before the deletion is committed. If
        // the token cache cannot be updated, nothing is committed.
        tokenCachePublished = true;
        try {
          await this.auth.publishTokenVersion(authId, tokenVersion);
        } catch {
          throw new TokenInvalidationUnavailableError();
        }
        // The row lock taken by the update above serializes this with any
        // concurrent request for the same account. An open request can only
        // exist here if the account was reactivated meanwhile; it is reused
        // (blocked again, sessions to be revoked again), never duplicated.
        const open = await tx.accountDeletionRequest.findFirst({
          where: { authId, status: { in: [...OPEN_STATUSES] } },
        });
        const request = open
          ? await tx.accountDeletionRequest.update({
              where: { id: open.id },
              data: {
                verificationMethod,
                accountBlockedAt: now,
                sessionsRevokedAt: null,
              },
            })
          : await tx.accountDeletionRequest.create({
              data: {
                authId,
                verificationMethod,
                requestedAt: now,
                accountBlockedAt: now,
              },
            });
        return { request, tokenVersion };
      });
      if (!outcome) return this.existingRequest(authId);
      accepted = outcome;
    } catch (error) {
      if (tokenCachePublished) {
        // The block was rolled back: let the cache reload the real version.
        await this.auth.forgetCachedTokenVersion(authId).catch(() => undefined);
      }
      if (error instanceof TokenInvalidationUnavailableError) {
        throw AppError.serviceUnavailable(
          'Account deletion is temporarily unavailable. Please try again later.',
        );
      }
      // A concurrent request already opened the deletion.
      if (this.isUniqueConstraintError(error)) {
        return this.existingRequest(authId);
      }
      throw error;
    }

    this.logger.info('Account deletion requested; account blocked', {
      context: 'AccountDeletion',
      requestId: accepted.request.id,
      verificationMethod,
    });
    const request = await this.revokeSessions(
      accepted.request,
      accepted.tokenVersion,
    );
    return this.toView(request);
  }

  /**
   * Revokes every refresh token and the cached token version. On failure the
   * request keeps `sessionsRevokedAt` null and records the attempt, and
   * AccountDeletionRecoveryService resumes it. The account is blocked in the
   * database either way.
   */
  async revokeSessions(
    request: AccountDeletionRequest,
    tokenVersion: number,
  ): Promise<AccountDeletionRequest> {
    try {
      await this.auth.revokeAllSessions(request.authId, tokenVersion);
    } catch (error) {
      this.logger.warn(
        'Sessions of an account pending deletion could not be revoked yet; will retry',
        {
          context: 'AccountDeletion',
          requestId: request.id,
          errorName: error instanceof Error ? error.name : typeof error,
        },
      );
      return this.prisma.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          attempts: { increment: 1 },
          lastError: 'Session revocation failed; it will be retried',
        },
      });
    }
    await this.prisma.accountDeletionRequest.updateMany({
      where: { id: request.id, sessionsRevokedAt: null },
      data: { sessionsRevokedAt: new Date(), lastError: null },
    });
    return this.prisma.accountDeletionRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
  }

  private async verifyIdentity(
    user: {
      id: string;
      provider: string;
      password: string;
      authSecurity: {
        failedAttempts: number;
        lockExpiresAt: Date | null;
      } | null;
    },
    dto: RequestAccountDeletionDto,
    meta: RequestMeta,
    now: Date,
  ): Promise<AccountDeletionVerification> {
    if (user.provider !== 'local') {
      // No password exists: the emailed code alone proves ownership.
      if (!dto.code || dto.password !== undefined) {
        throw AppError.badRequest(
          'Confirm the deletion with the code sent to your email address',
        );
      }
      await this.verifyCode(user.id, dto.code);
      return 'EMAIL_CODE';
    }

    if (!dto.password || !dto.code) {
      throw AppError.badRequest(
        'Confirm the deletion with your password and the code sent to your email address',
      );
    }
    const security = user.authSecurity;
    if (security?.lockExpiresAt && now < security.lockExpiresAt) {
      throw AppError.forbidden(
        'Account is temporarily locked. Please try again later.',
      );
    }
    // bcrypt compares in constant time.
    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) {
      if (security) {
        await this.auth.recordFailedPasswordConfirmation(
          user.id,
          security.failedAttempts,
          meta,
        );
      }
      throw AppError.forbidden(IDENTITY_VERIFICATION_FAILED);
    }
    await this.verifyCode(user.id, dto.code);
    return 'PASSWORD_AND_EMAIL_CODE';
  }

  private async verifyCode(userId: string, code: string): Promise<void> {
    if (!(await this.codes.verify(userId, code))) {
      throw AppError.forbidden(IDENTITY_VERIFICATION_FAILED);
    }
  }

  /** The open request of an account that is already pending deletion. */
  private async existingRequest(authId: string): Promise<AccountDeletionView> {
    const open = await this.prisma.accountDeletionRequest.findFirst({
      where: { authId, status: { in: [...OPEN_STATUSES] } },
      orderBy: { requestedAt: 'desc' },
    });
    if (!open) {
      throw AppError.conflict(
        'This account cannot be deleted in its current state',
      );
    }
    return this.toView(open);
  }

  private toView(request: AccountDeletionRequest): AccountDeletionView {
    return {
      id: request.id,
      status: request.status,
      requestedAt: request.requestedAt.toISOString(),
      accountBlockedAt: request.accountBlockedAt.toISOString(),
      sessionsRevoked: request.sessionsRevokedAt !== null,
      message:
        'Your account is blocked and scheduled for permanent deletion. You have been signed out on all devices.',
    };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}
