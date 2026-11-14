import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const PAYMENT_HISTORY_LIMITS = {
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

/**
 * Paging of the caller's own payment history. No user, customer or payment
 * identifiers are accepted: unknown query parameters are rejected.
 */
export class PaymentHistoryQueryDto {
  /** 1-based page number. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Entries per page (1-100). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAYMENT_HISTORY_LIMITS.MAX_LIMIT)
  limit?: number;
}
