import { IsBoolean, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { CREDIT_PACKAGE_LIMITS as LIMITS } from '../credit-package-settings.constants';

const isPresent = (_: object, value: unknown) => value !== undefined;

/**
 * Partial update of one credit package. Omitted fields are left unchanged;
 * a request with any invalid field changes nothing.
 *
 * `ValidateIf` is used instead of `IsOptional` so that an explicit `null` is
 * rejected rather than skipping validation.
 */
export class UpdateCreditPackageDto {
  /** Whole credits the package grants (1-1000000). */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.CREDITS_MIN)
  @Max(LIMITS.CREDITS_MAX)
  credits?: number;

  /** Price in whole US cents (50-999999), e.g. 500 for $5.00. */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(LIMITS.PRICE_USD_CENTS_MIN)
  @Max(LIMITS.PRICE_USD_CENTS_MAX)
  priceUsdCents?: number;

  /** Whether the package is offered for purchase. */
  @ValidateIf(isPresent)
  @IsBoolean()
  available?: boolean;
}
