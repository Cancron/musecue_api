import { IsBoolean, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { SUBSCRIPTION_PLAN_LIMITS as LIMITS } from '../subscription-plan.constants';

const isPresent = (_: object, value: unknown) => value !== undefined;

/**
 * Partial update of the Pro plan. Omitted fields are left unchanged.
 *
 * `ValidateIf` is used instead of `IsOptional` so that an explicit `null` is
 * rejected rather than skipping validation.
 */
export class UpdateSubscriptionPlanDto {
  /** Whether the Pro plan is offered. */
  @ValidateIf(isPresent)
  @IsBoolean()
  planEnabled?: boolean;

  /** Monthly price in whole US cents, e.g. 1900 for $19.00. */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.PRICE_USD_CENTS_MIN)
  @Max(LIMITS.PRICE_USD_CENTS_MAX)
  monthlyPriceUsdCents?: number;

  /** Yearly price in whole US cents, e.g. 19000 for $190.00. */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.PRICE_USD_CENTS_MIN)
  @Max(LIMITS.PRICE_USD_CENTS_MAX)
  yearlyPriceUsdCents?: number;

  /** Whether new subscribers get a free trial. */
  @ValidateIf(isPresent)
  @IsBoolean()
  trialEnabled?: boolean;

  /** Free-trial length in days. Kept while the trial is disabled. */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.TRIAL_DAYS_MIN)
  @Max(LIMITS.TRIAL_DAYS_MAX)
  trialDays?: number;
}
