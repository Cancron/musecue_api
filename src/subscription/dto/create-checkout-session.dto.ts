import { IsEnum } from 'class-validator';
import { BillingInterval } from '@prisma/client';

/** The caller's chosen billing option for the single Pro plan. */
export class CreateCheckoutSessionDto {
  @IsEnum(BillingInterval)
  billingInterval!: BillingInterval;
}
