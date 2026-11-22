import { BillingInterval } from '@prisma/client';
import { IsIn, IsString, Length, ValidateIf } from 'class-validator';

/**
 * Starts a Pro checkout. Only the billing option and an optional discount
 * code are accepted: the price, discount, currency and customer come from
 * the backend, and the user from the access token. Unknown fields are
 * rejected by the global ValidationPipe.
 */
export class CreateCheckoutSessionDto {
  /** `MONTHLY` or `YEARLY` (exact, case-sensitive). */
  @IsIn(Object.values(BillingInterval))
  billingInterval!: BillingInterval;

  /**
   * Optional discount code (case-insensitive). The checkout applies the best
   * available discount: this code, the first-purchase or referral discount,
   * or a running campaign, whichever has the highest percentage.
   */
  @ValidateIf((_: object, value: unknown) => value !== undefined)
  @IsString()
  @Length(1, 64)
  discountCode?: string;
}
