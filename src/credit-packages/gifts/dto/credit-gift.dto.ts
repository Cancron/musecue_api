import { CreditPackageCode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsIn,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

const isPresent = (_: object, value: unknown) => value !== undefined;

/** POST /v1/credit-package-gifts */
export class CreateCreditGiftDto {
  @IsEnum(CreditPackageCode)
  packageCode!: CreditPackageCode;

  /** The recipient's email address or username (an existing account). */
  @IsString()
  @Length(3, 254)
  recipient!: string;

  @ValidateIf(isPresent)
  @IsString()
  @Length(1, 280)
  message?: string;

  /**
   * When the credits are delivered (ISO 8601, at most 365 days ahead);
   * default: as soon as the gift is paid.
   */
  @ValidateIf(isPresent)
  @IsISO8601({ strict: true })
  deliverAt?: string;
}

/** POST /v1/credit-package-gifts/:id/checkout */
export class PayCreditGiftDto {
  @ValidateIf(isPresent)
  @IsString()
  @Length(1, 32)
  discountCode?: string;
}

/** GET /v1/credit-package-gifts */
export class ListCreditGiftsQueryDto {
  /** `sent` (default) or `received`. */
  @ValidateIf(isPresent)
  @IsIn(['sent', 'received'])
  box?: 'sent' | 'received';

  @ValidateIf(isPresent)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
