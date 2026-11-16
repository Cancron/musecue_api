import { Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AuthUtilsService } from '../../auth/services/auth-utils.service';
import config from '../../common/config/app.config';
import AppError from '../../common/errors/app.error';
import { EmailQueueService } from '../../common/queues/email/email.queue';
import { RedisService } from '../../common/services/redis.service';
import {
  ACCOUNT_DELETION_CODE_MAX_ATTEMPTS,
  ACCOUNT_DELETION_CODE_RATE_LIMIT,
  ACCOUNT_DELETION_CODE_TTL_SECONDS,
} from './account-deletion.constants';

interface StoredCode {
  codeHash: string;
  expiresAt: string;
}

/**
 * One-time email codes that let owners of accounts without a password (for
 * example Google sign-in) confirm an account deletion, following the email
 * verification-code convention. Codes are stored only as a hash bound to the
 * user, expire after 10 minutes, allow 5 guesses and work once.
 */
@Injectable()
export class AccountDeletionCodeService {
  constructor(
    private readonly redis: RedisService,
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
    const stored = await this.redis.set(
      this.codeKey(user.id),
      {
        codeHash: this.hash(user.id, code),
        expiresAt: expiresAt.toISOString(),
      } satisfies StoredCode,
      ACCOUNT_DELETION_CODE_TTL_SECONDS,
    );
    if (!stored) throw this.unavailable();
    // A new code gets a fresh set of guesses.
    await this.redis.del(this.attemptsKey(user.id));

    try {
      await this.emailQueue.sendAccountDeletionCode(
        user.email,
        user.username,
        code,
        ACCOUNT_DELETION_CODE_TTL_SECONDS / 60,
      );
    } catch {
      await this.redis.del(this.codeKey(user.id));
      throw this.unavailable();
    }
    return { expiresAt };
  }

  /**
   * Checks a code. A matching code is consumed; after too many wrong guesses
   * the code is invalidated. Redis failures are reported as unavailable,
   * never as a wrong code.
   */
  async verify(userId: string, code: string): Promise<boolean> {
    let stored: StoredCode | null;
    try {
      stored = await this.redis.getRequired<StoredCode>(this.codeKey(userId));
    } catch {
      throw this.unavailable();
    }
    if (!stored) return false;

    const attempts = await this.redis.incr(this.attemptsKey(userId));
    if (attempts === null) throw this.unavailable();
    if (attempts === 1) {
      await this.redis.expire(
        this.attemptsKey(userId),
        ACCOUNT_DELETION_CODE_TTL_SECONDS,
      );
    }
    if (attempts > ACCOUNT_DELETION_CODE_MAX_ATTEMPTS) {
      await this.invalidate(userId);
      return false;
    }

    const expected = Buffer.from(stored.codeHash, 'hex');
    const actual = Buffer.from(this.hash(userId, code.toUpperCase()), 'hex');
    const matches =
      expected.length === actual.length && timingSafeEqual(expected, actual);
    if (matches) await this.invalidate(userId);
    return matches;
  }

  /** Removes any outstanding code of an account (after it was erased). */
  async forget(userId: string): Promise<void> {
    await this.invalidate(userId);
  }

  private async invalidate(userId: string): Promise<void> {
    await this.redis.del(this.codeKey(userId));
    await this.redis.del(this.attemptsKey(userId));
  }

  private hash(userId: string, code: string): string {
    return createHash('sha256').update(`${userId}:${code}`).digest('hex');
  }

  private codeKey(userId: string): string {
    return `${config.redis_cache_key_prefix}:account_deletion_code:${userId}`;
  }

  private attemptsKey(userId: string): string {
    return `${this.codeKey(userId)}:attempts`;
  }

  private unavailable(): AppError {
    return AppError.serviceUnavailable(
      'Account deletion confirmation is temporarily unavailable',
    );
  }
}
