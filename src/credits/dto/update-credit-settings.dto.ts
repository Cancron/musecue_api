import { IsInt, Max, Min, ValidateIf } from 'class-validator';
import { CREDIT_SETTINGS_LIMITS as LIMITS } from '../credit-settings.constants';

const isPresent = (_: object, value: unknown) => value !== undefined;

/**
 * Partial update of the AI credit settings. Omitted fields are left
 * unchanged; a request with any invalid field changes nothing.
 *
 * `ValidateIf` is used instead of `IsOptional` so that an explicit `null` is
 * rejected rather than skipping validation.
 */
export class UpdateCreditSettingsDto {
  /** Credits granted for the free trial (whole credits, 1-100000). */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.TRIAL_CREDITS_MIN)
  @Max(LIMITS.TRIAL_CREDITS_MAX)
  trialCredits?: number;

  /** Credits granted per monthly Pro period (whole credits, 1-1000000). */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.PRO_MONTHLY_CREDITS_MIN)
  @Max(LIMITS.PRO_MONTHLY_CREDITS_MAX)
  proMonthlyCredits?: number;

  /**
   * OpenRouter cost covered by one credit, in millionths of a US dollar
   * (1-1000000), e.g. 5000 for $0.005.
   */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.CREDIT_COST_USD_MICROS_MIN)
  @Max(LIMITS.CREDIT_COST_USD_MICROS_MAX)
  creditCostUsdMicros?: number;

  /** Credits a session may use beyond the remaining balance (0-1000). */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.SESSION_OVERAGE_CREDITS_MIN)
  @Max(LIMITS.SESSION_OVERAGE_CREDITS_MAX)
  sessionOverageCredits?: number;

  /**
   * AI usage is charged in multiples of this step, rounded up, in millionths
   * of a credit (1-1000000): 1 (default) charges exact fractional credits,
   * 100000 tenths, 1000000 whole credits.
   */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.DEDUCTION_STEP_MICRO_CREDITS_MIN)
  @Max(LIMITS.DEDUCTION_STEP_MICRO_CREDITS_MAX)
  deductionStepMicroCredits?: number;
}
