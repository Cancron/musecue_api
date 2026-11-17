import { Injectable } from '@nestjs/common';
import { AuthUtilsService } from '../../auth/services/auth-utils.service';
import { AuthChallengeRepository } from '../../auth/state/auth-challenge.repository';
import AppError from '../../common/errors/app.error';
import { EmailQueueService } from '../../common/queues/email/email.queue';
import {
  ACCOUNT_DELETION_CODE_MAX_ATTEMPTS,
  ACCOUNT_DELETION_CODE_RATE_LIMIT,
  ACCOUNT_DELETION_CODE_TTL_SECONDS,
} from './account-deletion.constants';

/**
 * One-time email codes that confirm an account deletion, following the email
 * verification-code convention. Codes are stored in PostgreSQL only as an
 * HMAC bound to the purpose and the user, expire after 10 minutes, allow 5
 * guesses and work once.
 */
@Injectable()
export class AccountDeletionCodeService {
  constructor(
    private readonly challenges: AuthChallengeRepository,
    private readonly authUtils: AuthUtilsService,
    private readonly emailQueue: EmailQueueService,
  ) {}

  async issue(
    user: { id: string; email: string; username: string },
    now: Date = new Date(),
  ): Promise<{ expiresAt: Date }> {
    await this.authUtils.checkRateLimit(
      `account_deletion_code:user:${user.id}`,
      ACCOUNT_DELETION_CODE_RATE_LIMIT.max,
      ACCOUNT_DELETION_CODE_RATE_LIMIT.windowMs,
    );
    const code = this.authUtils.generateVerificationCode();
    const expiresAt = new Date(
      now.getTime() + ACCOUNT_DELETION_CODE_TTL_SECONDS * 1000,
    );
    try {
      // A new code replaces the previous one and gets a fresh set of guesses.
      await this.challenges.issue(user.id, 'ACCOUNT_DELETION', code, {
        expiresAt,
        maxAttempts: ACCOUNT_DELETION_CODE_MAX_ATTEMPTS,
      });
    } catch {
      throw this.unavailable();
    }

    try {
      await this.emailQueue.sendAccountDeletionCode(
        user.email,
        user.username,
        code,
        ACCOUNT_DELETION_CODE_TTL_SECONDS / 60,
        user.id,
      );
    } catch {
      await this.forget(user.id).catch(() => undefined);
      throw this.unavailable();
    }
    return { expiresAt };
  }

  /**
   * Checks a code. A matching code is consumed; after too many guesses the
   * code stops working. Database failures are reported as unavailable, never
   * as a wrong code.
   */
  async verify(
    userId: string,
    code: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    try {
      const check = await this.challenges.verify(
        userId,
        'ACCOUNT_DELETION',
        code.toUpperCase(),
        { now },
      );
      return check === 'VALID';
    } catch {
      throw this.unavailable();
    }
  }

  /** Removes any outstanding code of an account (after it was erased). */
  async forget(userId: string): Promise<void> {
    await this.challenges.remove(userId, 'ACCOUNT_DELETION');
  }

  private unavailable(): AppError {
    return AppError.serviceUnavailable(
      'Account deletion confirmation is temporarily unavailable',
    );
  }
}
