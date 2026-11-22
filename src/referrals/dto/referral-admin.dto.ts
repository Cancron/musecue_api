import { ReferralStatus } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { MILESTONE_LIMITS as LIMITS } from '../referral-milestone.service';

const isPresent = (_: object, value: unknown) => value !== undefined;

/** POST /v1/admin/referral-milestones */
export class CreateReferralMilestoneDto {
  /** Paid referrals needed (1-100000); unique, never changes. */
  @IsInt()
  @Min(LIMITS.REFERRAL_COUNT_MIN)
  @Max(LIMITS.REFERRAL_COUNT_MAX)
  referralCount!: number;

  /** Credits awarded (1-1000000), non-expiring REFERRAL credits. */
  @IsInt()
  @Min(LIMITS.REWARD_CREDITS_MIN)
  @Max(LIMITS.REWARD_CREDITS_MAX)
  rewardCredits!: number;

  @ValidateIf(isPresent)
  @IsBoolean()
  active?: boolean;
}

/** PATCH /v1/admin/referral-milestones/:id (the threshold never changes). */
export class UpdateReferralMilestoneDto {
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.REWARD_CREDITS_MIN)
  @Max(LIMITS.REWARD_CREDITS_MAX)
  rewardCredits?: number;

  @ValidateIf(isPresent)
  @IsBoolean()
  active?: boolean;
}

/** GET /v1/admin/referrals (default: HELD, the review queue). */
export class ListReferralReviewsQueryDto {
  @ValidateIf(isPresent)
  @IsEnum(ReferralStatus)
  status?: ReferralStatus;
}
