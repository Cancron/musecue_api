import { Injectable } from '@nestjs/common';
import type { AuthChallengePurpose, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import {
  hexDigestsEqual,
  keyedHash,
  SECRET_PURPOSES,
} from '../../common/security/derived-secrets';

/**
 * - VALID: the code matched and was consumed.
 * - INVALID: wrong code (the guess was counted).
 * - EXPIRED: no usable challenge (none issued, expired, already used, or its
 *   attempts are used up).
 */
export type ChallengeCheck = 'VALID' | 'INVALID' | 'EXPIRED';

export interface ChallengeOptions {
  expiresAt: Date;
  maxAttempts: number;
}

/**
 * One-time emailed codes (email verification, account deletion) in
 * PostgreSQL. Codes are stored only as an HMAC bound to the purpose and the
 * user, so a code issued for one purpose or account never works for another.
 */
@Injectable()
export class AuthChallengeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Issues (or replaces) the user's challenge for `purpose`: a new code gets
   * a fresh expiry and a fresh set of attempts.
   */
  async issue(
    authId: string,
    purpose: AuthChallengePurpose,
    code: string,
    options: ChallengeOptions,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const data = {
      codeHash: this.hash(authId, purpose, code),
      attempts: 0,
      maxAttempts: options.maxAttempts,
      expiresAt: options.expiresAt,
      consumedAt: null,
    };
    await client.authChallenge.upsert({
      where: { authId_purpose: { authId, purpose } },
      create: { authId, purpose, ...data },
      update: data,
    });
  }

  /**
   * Checks a code. Every check of a usable challenge counts as an attempt; a
   * matching code is consumed in the same transaction, so it works once even
   * when submitted concurrently. `onValid` runs inside that transaction (for
   * writes that must commit together with the consumption); if it throws,
   * nothing is committed.
   */
  async verify(
    authId: string,
    purpose: AuthChallengePurpose,
    code: string,
    options: {
      now?: Date;
      onValid?: (tx: Prisma.TransactionClient) => Promise<void>;
    } = {},
  ): Promise<ChallengeCheck> {
    const now = options.now ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const counted = await tx.authChallenge.updateMany({
        where: {
          authId,
          purpose,
          consumedAt: null,
          expiresAt: { gt: now },
          attempts: { lt: tx.authChallenge.fields.maxAttempts },
        },
        data: { attempts: { increment: 1 } },
      });
      if (counted.count !== 1) return 'EXPIRED';
      const challenge = await tx.authChallenge.findUnique({
        where: { authId_purpose: { authId, purpose } },
        select: { id: true, codeHash: true },
      });
      if (!challenge) return 'EXPIRED';
      if (
        !hexDigestsEqual(challenge.codeHash, this.hash(authId, purpose, code))
      ) {
        return 'INVALID';
      }
      const consumed = await tx.authChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return 'EXPIRED';
      if (options.onValid) await options.onValid(tx);
      return 'VALID';
    });
  }

  /** Removes a user's challenges (all purposes when omitted). */
  async remove(authId: string, purpose?: AuthChallengePurpose): Promise<void> {
    await this.prisma.authChallenge.deleteMany({
      where: { authId, ...(purpose ? { purpose } : {}) },
    });
  }

  /** Removes challenges that expired or were used before `before`. */
  async deleteExpired(before: Date): Promise<number> {
    const { count } = await this.prisma.authChallenge.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: before } }, { consumedAt: { lt: before } }],
      },
    });
    return count;
  }

  private hash(
    authId: string,
    purpose: AuthChallengePurpose,
    code: string,
  ): string {
    return keyedHash(
      SECRET_PURPOSES.AUTH_CHALLENGE,
      `${purpose}\u0000${authId}\u0000${code}`,
    );
  }
}
