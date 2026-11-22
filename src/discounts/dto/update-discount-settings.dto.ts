import { IsInt, Max, Min, ValidateIf } from 'class-validator';
import { DISCOUNT_SETTINGS_LIMITS as LIMITS } from '../discount-settings.constants';

const isPresent = (_: object, value: unknown) => value !== undefined;

/**
 * Partial update of the discount and referral settings. Omitted fields are
 * left unchanged; a request with any invalid field changes nothing. 0
 * switches an offer off.
 *
 * `ValidateIf` is used instead of `IsOptional` so that an explicit `null` is
 * rejected rather than skipping validation.
 */
export class UpdateDiscountSettingsDto {
  /** Percentage off a user's first paying purchase (whole percent, 0-100). */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.PERCENT_MIN)
  @Max(LIMITS.PERCENT_MAX)
  firstPurchaseDiscountPercent?: number;

  /** Percentage off the purchase of a referred user (whole percent, 0-100). */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.PERCENT_MIN)
  @Max(LIMITS.PERCENT_MAX)
  referralDiscountPercent?: number;

  /**
   * Credits for the referring user after the referred user's first paying
   * purchase succeeded (whole credits, 0-100000).
   */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.REFERRER_REWARD_CREDITS_MIN)
  @Max(LIMITS.REFERRER_REWARD_CREDITS_MAX)
  referrerRewardCredits?: number;
}
