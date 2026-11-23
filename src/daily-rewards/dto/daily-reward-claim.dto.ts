import { Type } from 'class-transformer';
import { IsInt, Matches, Max, Min, ValidateIf } from 'class-validator';

const isPresent = (_: object, value: unknown) => value !== undefined;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * POST /v1/daily-rewards/claim (the body is optional). A claim is always
 * for the current UTC day; `claimDate`, if sent, must be that day: a past
 * (missed) or future day is refused.
 */
export class ClaimDailyRewardDto {
  @ValidateIf(isPresent)
  @Matches(DAY, { message: 'claimDate must be a date (YYYY-MM-DD)' })
  claimDate?: string;
}

/** GET /v1/daily-rewards/history */
export class DailyRewardHistoryQueryDto {
  /** 1-100 claims (default 31). */
  @ValidateIf(isPresent)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** `nextCursor` of the previous page (a claimed day, YYYY-MM-DD). */
  @ValidateIf(isPresent)
  @Matches(DAY, { message: 'cursor must be a nextCursor value' })
  cursor?: string;

  /** Only this UTC month (YYYY-MM). */
  @ValidateIf(isPresent)
  @Matches(MONTH, { message: 'month must be YYYY-MM' })
  month?: string;
}

/** GET /v1/daily-rewards/months */
export class DailyRewardMonthsQueryDto {
  /** 1-24 months (default 12), newest first. */
  @ValidateIf(isPresent)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  limit?: number;
}
