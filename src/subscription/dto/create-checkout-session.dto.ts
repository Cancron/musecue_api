import { BillingInterval } from '@prisma/client';
import { IsIn } from 'class-validator';

/**
 * Starts a Pro checkout. Only the billing option is accepted: the price,
 * currency and customer come from the backend, and the user from the access
 * token. Unknown fields are rejected by the global ValidationPipe.
 */
export class CreateCheckoutSessionDto {
  /** `MONTHLY` or `YEARLY` (exact, case-sensitive). */
  @IsIn(Object.values(BillingInterval))
  billingInterval!: BillingInterval;
}
