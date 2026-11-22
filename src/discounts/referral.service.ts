import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { DiscountSettingsService } from './discount-settings.service';
import { hasPaidPurchase } from './paid-purchase';

/** Unambiguous characters (no 0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export const REFERRAL_MESSAGES = {
  CODE_NOT_FOUND: 'Referral code not found',
  OWN_CODE: 'You cannot use your own referral code',
  ALREADY_REFERRED: 'A referral code was already applied to your account',
  ALREADY_PURCHASED:
    'Referral codes can only be applied before your first purchase',
} as const;

export interface ReferralView {
  /** The caller's own code, to share. */
  code: string;
  /** Whether the caller signed up through someone's code. */
  referred: boolean;
  /**
   * The referral discount the caller would get on their first purchase
   * (0 when not referred, already purchased, or the offer is switched off).
   */
  referralDiscountPercent: number;
}

/**
 * Referral attribution: every user has their own referral code, and a user
 * who has not made a paid purchase yet can apply someone else's code once.
 * The referred user then gets the referral discount (DiscountSettings) on
 * their first purchase.
 */
@Injectable()
export class ReferralService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: DiscountSettingsService,
  ) {}

  async getReferral(authId: string): Promise<ReferralView> {
    const code = await this.ensureCode(authId);
    const referral = await this.prisma.referral.findUnique({
      where: { authId },
    });
    const percent = (await this.settings.getSettings()).referralDiscountPercent;
    const available =
      referral !== null &&
      percent > 0 &&
      !(await hasPaidPurchase(this.prisma, authId));
    return {
      code,
      referred: referral !== null,
      referralDiscountPercent: available ? percent : 0,
    };
  }

  /**
   * Applies another user's referral code to the caller. Once per user, never
   * the caller's own code, and only before the first paid purchase.
   */
  async applyCode(authId: string, rawCode: string): Promise<ReferralView> {
    const code = rawCode.trim().toUpperCase();
    await this.prisma
      .$transaction(async (tx) => {
        // Serializes with the user's checkouts and payments.
        await tx.userSubscription.createMany({
          data: [{ authId }],
          skipDuplicates: true,
        });
        await tx.$queryRaw`
        SELECT "id" FROM "UserSubscription" WHERE "authId" = ${authId} FOR UPDATE
      `;
        const owner = await tx.referralCode.findUnique({ where: { code } });
        if (!owner) throw AppError.notFound(REFERRAL_MESSAGES.CODE_NOT_FOUND);
        if (owner.authId === authId) {
          throw AppError.badRequest(REFERRAL_MESSAGES.OWN_CODE);
        }
        if (await tx.referral.findUnique({ where: { authId } })) {
          throw AppError.conflict(REFERRAL_MESSAGES.ALREADY_REFERRED);
        }
        if (await hasPaidPurchase(tx, authId)) {
          throw AppError.conflict(REFERRAL_MESSAGES.ALREADY_PURCHASED);
        }
        await tx.referral.create({
          data: { authId, referrerAuthId: owner.authId },
        });
      })
      .catch((error: unknown) => {
        // A concurrent request applied a code first.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw AppError.conflict(REFERRAL_MESSAGES.ALREADY_REFERRED);
        }
        throw error;
      });
    return this.getReferral(authId);
  }

  /** The user's code, created on first use (unique; retried on collision). */
  private async ensureCode(authId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await this.prisma.referralCode.findUnique({
        where: { authId },
      });
      if (existing) return existing.code;
      const { count } = await this.prisma.referralCode.createMany({
        data: [{ authId, code: randomCode() }],
        skipDuplicates: true,
      });
      if (count === 0) continue;
    }
    const stored = await this.prisma.referralCode.findUnique({
      where: { authId },
    });
    if (!stored) throw AppError.internalServerError();
    return stored.code;
  }
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}
