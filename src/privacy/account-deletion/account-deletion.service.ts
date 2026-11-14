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

/**
 * Accepts a signed-in user's request to permanently delete their own
 * account.
 *
 * The owner proves their identity again (password, or an emailed code for
 * accounts without a password). Accepting the request blocks the account in
 * the same transaction that records it (status PENDING_DELETION and a new
 * token version, so no existing or new token works), then revokes every
 * session. Repeated or concurrent requests return the same open request: at
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

  /** Emails a confirmation code; only for accounts without a password. */
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
    if (user.provider === 'local') {
      throw AppError.badRequest(
        'This account has a password; confirm the deletion with it',
      );
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
      if (!dto.code || dto.password !== undefined) {
        throw AppError.badRequest(
          'Confirm the deletion with the code sent to your email address',
        );
      }
      if (!(await this.codes.verify(user.id, dto.code))) {
        throw AppError.forbidden(IDENTITY_VERIFICATION_FAILED);
      }
      return 'EMAIL_CODE';
    }

    if (!dto.password || dto.code !== undefined) {
      throw AppError.badRequest('Confirm the deletion with your password');
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
    return 'PASSWORD';
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
