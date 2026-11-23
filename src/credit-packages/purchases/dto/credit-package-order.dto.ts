import { Type } from 'class-transformer';
import { IsInt, IsString, Length, Max, Min, ValidateIf } from 'class-validator';

const isPresent = (_: object, value: unknown) => value !== undefined;

/** POST /v1/credit-packages/:code/checkout */
export class CreateCreditPackageOrderDto {
  /** A discount code the user entered (case-insensitive). */
  @ValidateIf(isPresent)
  @IsString()
  @Length(1, 32)
  discountCode?: string;
}

/** GET /v1/credit-package-orders */
export class ListCreditPackageOrdersQueryDto {
  /** 1-100 orders (default 20), newest first. */
  @ValidateIf(isPresent)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
