import { applyDecorators } from '@nestjs/common';
import {
  CreditPackageCode,
  DiscountCustomerEligibility,
  DiscountProduct,
} from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  DISCOUNT_OFFER_LIMITS as LIMITS,
  ZONED_ISO_DATE_TIME,
} from '../discount-offer.constants';

/** Validate when the field is in the body (an explicit null is rejected). */
const isPresent = (_: object, value: unknown) => value !== undefined;
/** Validate unless absent or null (for fields where null has a meaning). */
const isSet = (_: object, value: unknown) =>
  value !== undefined && value !== null;

const NameField = () =>
  applyDecorators(
    IsString(),
    MaxLength(LIMITS.NAME_MAX_LENGTH),
    Matches(/\S/, { message: 'name must not be blank' }),
  );
const PercentField = () =>
  applyDecorators(IsInt(), Min(LIMITS.PERCENT_MIN), Max(LIMITS.PERCENT_MAX));
const InstantField = () =>
  applyDecorators(
    IsString(),
    Matches(ZONED_ISO_DATE_TIME, {
      message:
        '$property must be an ISO 8601 date or a date-time with a time zone (Z or an offset)',
    }),
    IsISO8601({ strict: true }),
  );
const PerUserField = () =>
  applyDecorators(
    IsInt(),
    Min(LIMITS.MAX_REDEMPTIONS_PER_USER_MIN),
    Max(LIMITS.MAX_REDEMPTIONS_PER_USER_MAX),
  );
const TotalField = () =>
  applyDecorators(
    IsInt(),
    Min(LIMITS.MAX_TOTAL_REDEMPTIONS_MIN),
    Max(LIMITS.MAX_TOTAL_REDEMPTIONS_MAX),
  );
const MinSpendField = () =>
  applyDecorators(
    IsInt(),
    Min(LIMITS.MIN_SPEND_CENTS_MIN),
    Max(LIMITS.MIN_SPEND_CENTS_MAX),
  );
const BudgetField = () =>
  applyDecorators(
    IsInt(),
    Min(LIMITS.BUDGET_CENTS_MIN),
    Max(LIMITS.BUDGET_CENTS_MAX),
  );
const ProductsField = () =>
  applyDecorators(
    IsArray(),
    ArrayMinSize(1, {
      message:
        'eligibleProducts must list at least one product; use null for every product',
    }),
    ArrayUnique(),
    IsEnum(DiscountProduct, { each: true }),
  );
const TargetsField = () =>
  applyDecorators(
    IsArray(),
    ArrayMinSize(1, {
      message:
        'targetUserIds must list at least one user; use null to offer it to everyone',
    }),
    ArrayMaxSize(LIMITS.TARGET_USERS_MAX),
    ArrayUnique(),
    IsString({ each: true }),
    Length(1, LIMITS.USER_ID_MAX_LENGTH, { each: true }),
  );

/**
 * Optional on creation and on change: omitted fields keep their default
 * (creation) or stored value (change). `maxTotalRedemptions: null` means
 * unlimited and `targetUserIds: null` offers it to every user.
 */
class DiscountOfferOptionsDto {
  /** Default true. A 0% discount also switches the offer off. */
  @ValidateIf(isPresent)
  @IsBoolean()
  active?: boolean;

  /** Redemptions allowed per user (1-1000, default 1). */
  @ValidateIf(isPresent)
  @PerUserField()
  maxRedemptionsPerUser?: number;

  /** Redemptions allowed in total (1-10000000; null = unlimited, the default). */
  @ValidateIf(isSet)
  @TotalField()
  maxTotalRedemptions?: number | null;

  /** Only these users may redeem it (1-1000 IDs); null = every user (default). */
  @ValidateIf(isSet)
  @TargetsField()
  targetUserIds?: string[] | null;

  /** New customers (no paid purchase yet), returning ones, or all (default). */
  @ValidateIf(isPresent)
  @IsEnum(DiscountCustomerEligibility)
  customerEligibility?: DiscountCustomerEligibility;

  /** Products it applies to; null = every product (default). */
  @ValidateIf(isSet)
  @ProductsField()
  eligibleProducts?: DiscountProduct[] | null;

  /** Minimum list price of the purchase in cents (0-999999, default 0). */
  @ValidateIf(isPresent)
  @MinSpendField()
  minSpendCents?: number;

  /** USD budget for the discounts in cents (1-100000000; null = unlimited). */
  @ValidateIf(isSet)
  @BudgetField()
  budgetCents?: number | null;
}

/**
 * A partial change of a code or campaign (a code's `code` never changes;
 * sending it is rejected as an unknown field).
 */
class DiscountOfferChangeDto extends DiscountOfferOptionsDto {
  @ValidateIf(isPresent)
  @NameField()
  name?: string;

  /** 0-100 whole percent; 0 switches the offer off. */
  @ValidateIf(isPresent)
  @PercentField()
  discountPercent?: number;

  @ValidateIf(isPresent)
  @InstantField()
  startsAt?: string;

  @ValidateIf(isPresent)
  @InstantField()
  endsAt?: string;
}

export class UpdateDiscountCodeDto extends DiscountOfferChangeDto {}

export class UpdateDiscountCampaignDto extends DiscountOfferChangeDto {}

/** A new discount code; the name defaults to the code. */
export class CreateDiscountCodeDto extends DiscountOfferOptionsDto {
  /** 3-32 letters, digits, "_" or "-"; case-insensitive (stored upper case). */
  @IsString()
  @Matches(LIMITS.CODE_PATTERN, {
    message:
      'code must be 3-32 letters, digits, "_" or "-", starting with a letter or digit',
  })
  code!: string;

  @ValidateIf(isPresent)
  @NameField()
  name?: string;

  /** 0-100 whole percent; 0 creates the code switched off. */
  @PercentField()
  discountPercent!: number;

  @InstantField()
  startsAt!: string;

  @InstantField()
  endsAt!: string;
}

/** A new campaign, e.g. a holiday promotion. */
export class CreateDiscountCampaignDto extends DiscountOfferOptionsDto {
  @NameField()
  name!: string;

  /** 0-100 whole percent; 0 creates the campaign switched off. */
  @PercentField()
  discountPercent!: number;

  @InstantField()
  startsAt!: string;

  @InstantField()
  endsAt!: string;
}

/** Redeems a discount code for one credit package. */
export class RedeemDiscountCodeDto {
  @IsString()
  @Length(1, LIMITS.REDEEM_CODE_MAX_LENGTH)
  code!: string;

  @IsEnum(CreditPackageCode)
  packageCode!: CreditPackageCode;
}

/** Redeems a campaign for one credit package. */
export class RedeemDiscountCampaignDto {
  @IsEnum(CreditPackageCode)
  packageCode!: CreditPackageCode;
}
