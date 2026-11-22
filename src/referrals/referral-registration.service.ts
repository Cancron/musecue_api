import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import {
  canonicalEmailHash,
  isSameMailbox,
  normalizeReferralCode,
} from './referral.policy';

export const REFERRAL_MESSAGES = {
  INVALID_CODE: 'Invalid referral code',
  SELF_REFERRAL: 'You cannot use your own referral code',
  ALREADY_REFERRED: 'A referral was already registered for this email address',
  SIGNUP_ONLY: 'Referral codes can only be used when signing up',
} as const;

interface Referrer {
  code: string;
  referrerAuthId: string;
  referrerEmail: string;
}

/**
 * Referral registration. A referral is recorded only when an account is
 * created (local registration or a first Google sign-in), in the same
 * transaction, so a refused referral creates no account and an existing
 * account can never be referred afterwards. Refused:
 * - invalid codes (malformed, unknown, or whose owner is not active): 400;
 * - self-referrals (the new email is the code owner's mailbox): 400;
 * - a second referral of the same person (same mailbox): 409.
 */
@Injectable()
export class ReferralRegistrationService {
  constructor(private readonly prisma: PrismaService) {}

  /** The active owner of a referral code; 400 for an invalid code. */
  async findReferrer(
    rawCode: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Referrer> {
    const code = normalizeReferralCode(rawCode);
    const owner = code
      ? await client.referralCode.findUnique({
          where: { code },
          select: {
            authId: true,
            authUser: {
              select: { email: true, status: true, deletedAt: true },
            },
          },
        })
      : null;
    if (
      !code ||
      !owner ||
      owner.authUser.status !== 'ACTIVE' ||
      owner.authUser.deletedAt !== null
    ) {
      throw AppError.badRequest(REFERRAL_MESSAGES.INVALID_CODE);
    }
    return {
      code,
      referrerAuthId: owner.authId,
      referrerEmail: owner.authUser.email,
    };
  }

  /**
   * Every check, before the account is created (nothing is written when it
   * fails). Repeated inside the signup transaction by registerAtSignup.
   */
  async assertUsableAtSignup(
    rawCode: string,
    email: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Referrer> {
    const referrer = await this.findReferrer(rawCode, client);
    if (isSameMailbox(referrer.referrerEmail, email)) {
      throw AppError.badRequest(REFERRAL_MESSAGES.SELF_REFERRAL);
    }
    const existing = await client.referral.findUnique({
      where: { canonicalEmailHash: canonicalEmailHash(email) },
      select: { id: true },
    });
    if (existing) throw AppError.conflict(REFERRAL_MESSAGES.ALREADY_REFERRED);
    return referrer;
  }

  /**
   * Records the referral of a new account, in the transaction that creates
   * it (the account row already exists in `tx`).
   */
  async registerAtSignup(
    tx: Prisma.TransactionClient,
    input: { authId: string; email: string; code: string },
  ): Promise<void> {
    const referrer = await this.assertUsableAtSignup(
      input.code,
      input.email,
      tx,
    );
    try {
      await tx.referral.create({
        data: {
          authId: input.authId,
          referrerAuthId: referrer.referrerAuthId,
          referralCode: referrer.code,
          canonicalEmailHash: canonicalEmailHash(input.email),
        },
      });
    } catch (error) {
      // The same person signed up concurrently with another address.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw AppError.conflict(REFERRAL_MESSAGES.ALREADY_REFERRED);
      }
      throw error;
    }
  }
}
