import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

export const CREDIT_HISTORY_FILTERS = [
  'ALLOCATION',
  'DEDUCTION',
  'EXPIRATION',
  /** Deductions that used session overage. */
  'OVERAGE',
] as const;
export type CreditHistoryFilter = (typeof CREDIT_HISTORY_FILTERS)[number];

/**
 * Query of GET /v1/credits/transactions. There is no user parameter: the
 * history is always the caller's (unknown parameters are rejected).
 */
export class ListCreditTransactionsDto {
  /** Page size, 1-100 (default 50). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Only transactions older than this cursor (`nextCursor`). */
  @IsOptional()
  @Matches(/^[1-9][0-9]{0,17}$/)
  before?: string;

  @IsOptional()
  @IsIn(CREDIT_HISTORY_FILTERS)
  type?: CreditHistoryFilter;

  /** Only the transactions of one of the caller's makeup sessions. */
  @IsOptional()
  @IsUUID()
  sessionId?: string;
}
