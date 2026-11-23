import { LoyaltyMissionRecurrence } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { LOYALTY_MISSION_LIMITS as LIMITS } from '../loyalty-mission.policy';

const isPresent = (_: object, value: unknown) => value !== undefined;
const NOT_BLANK = /\S/;

/** POST /v1/admin/loyalty-missions */
export class CreateLoyaltyMissionDto {
  @IsString()
  @Length(1, LIMITS.TITLE_MAX)
  @Matches(NOT_BLANK, { message: 'title must not be blank' })
  title!: string;

  @ValidateIf(
    (_: object, value: unknown) => value !== undefined && value !== null,
  )
  @IsString()
  @Length(1, LIMITS.DESCRIPTION_MAX)
  description?: string | null;

  /** ONCE (once ever), WEEKLY or MONTHLY (once per UTC week / month). */
  @IsEnum(LoyaltyMissionRecurrence)
  recurrence!: LoyaltyMissionRecurrence;

  /** Verified makeup completions needed (1 = single step, up to 100). */
  @IsInt()
  @Min(LIMITS.REQUIRED_COMPLETIONS_MIN)
  @Max(LIMITS.REQUIRED_COMPLETIONS_MAX)
  requiredCompletions!: number;

  /** MISSION_REWARD credits awarded (1-100000). */
  @IsInt()
  @Min(LIMITS.REWARD_CREDITS_MIN)
  @Max(LIMITS.REWARD_CREDITS_MAX)
  rewardCredits!: number;

  @ValidateIf(isPresent)
  @IsBoolean()
  active?: boolean;
}

/**
 * PATCH /v1/admin/loyalty-missions/:id. The recurrence and the required
 * completions never change (create another mission instead).
 */
export class UpdateLoyaltyMissionDto {
  @ValidateIf(isPresent)
  @IsString()
  @Length(1, LIMITS.TITLE_MAX)
  @Matches(NOT_BLANK, { message: 'title must not be blank' })
  title?: string;

  /** null removes the description. */
  @ValidateIf(
    (_: object, value: unknown) => value !== undefined && value !== null,
  )
  @IsString()
  @Length(1, LIMITS.DESCRIPTION_MAX)
  description?: string | null;

  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.REWARD_CREDITS_MIN)
  @Max(LIMITS.REWARD_CREDITS_MAX)
  rewardCredits?: number;

  @ValidateIf(isPresent)
  @IsBoolean()
  active?: boolean;
}

/** GET /v1/loyalty-missions/awards */
export class LoyaltyMissionAwardsQueryDto {
  /** 1-100 awards (default 50), newest first. */
  @ValidateIf(isPresent)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
