import { IsInt, Max, Min, ValidateIf } from 'class-validator';
import { CREDIT_SETTINGS_LIMITS as LIMITS } from '../credit-settings.constants';

const isPresent = (_: object, value: unknown) => value !== undefined;

/**
 * Partial update of the AI credit settings. Omitted fields are left
 * unchanged.
 *
 * `ValidateIf` is used instead of `IsOptional` so that an explicit `null` is
 * rejected rather than skipping validation. `IsInt` rejects numeric strings:
 * the global ValidationPipe does not enable implicit conversion.
 */
export class UpdateCreditSettingsDto {
  /** Credits granted once with the free trial, e.g. 50. */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.ALLOWANCE_CREDITS_MIN)
  @Max(LIMITS.ALLOWANCE_CREDITS_MAX)
  trialAllowanceCredits?: number;

  /** Credits granted for each monthly Pro period, e.g. 1000. */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.ALLOWANCE_CREDITS_MIN)
  @Max(LIMITS.ALLOWANCE_CREDITS_MAX)
  proMonthlyAllowanceCredits?: number;

  /**
   * OpenRouter cost per credit in whole millionths of a US dollar, e.g. 5000
   * for $0.005 per credit.
   */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.USD_MICROS_PER_CREDIT_MIN)
  @Max(LIMITS.USD_MICROS_PER_CREDIT_MAX)
  openRouterUsdMicrosPerCredit?: number;

  /** Credits a makeup session may use beyond the remaining balance, e.g. 5. */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.SESSION_OVERAGE_CREDITS_MIN)
  @Max(LIMITS.SESSION_OVERAGE_CREDITS_MAX)
  sessionOverageAllowanceCredits?: number;
}
