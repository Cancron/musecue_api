import type {
  AiOperation,
  CreditSource,
  MakeupSessionStatus,
} from '@prisma/client';
import type { CreditAmountString } from '../interfaces/credit-wallet.interface';

/** Where an allocation's credits are now. */
export type CreditAllocationState =
  /** Holds credits that can be spent now. */
  | 'AVAILABLE'
  /** Allocated for a month that has not started yet. */
  | 'UPCOMING'
  /** Every credit was spent. */
  | 'USED_UP'
  /** Expired; unspent credits were removed. */
  | 'EXPIRED';

/** One allocation (grant) of credits and what became of it. */
export interface CreditAccountAllocationView {
  id: string;
  source: CreditSource;
  state: CreditAllocationState;
  /** Granted: available + upcoming + used + expired. */
  granted: CreditAmountString;
  available: CreditAmountString;
  upcoming: CreditAmountString;
  used: CreditAmountString;
  expired: CreditAmountString;
  grantedAt: string;
  /** SUBSCRIPTION: the month the credits are for. */
  periodStart: string | null;
  /** TRIAL and SUBSCRIPTION only; purchased and referral credits never expire. */
  expiresAt: string | null;
  /** When unspent credits were removed (at expiresAt, or earlier). */
  expiredAt: string | null;
}

/** The credits of one source. */
export interface CreditSourceBalanceView {
  source: CreditSource;
  granted: CreditAmountString;
  available: CreditAmountString;
  upcoming: CreditAmountString;
  used: CreditAmountString;
  expired: CreditAmountString;
  /** Whether credits of this source expire (false for PURCHASE, REFERRAL). */
  expires: boolean;
  /** Whether the user may spend them now (e.g. trial credits only during the trial). */
  usableNow: boolean;
  /** The earliest expiry of this source's available or upcoming credits. */
  nextExpiresAt: string | null;
}

export interface CreditAccountBalanceView {
  /**
   * Credits the user holds now, of every source. Expired credits never
   * count; credits of a month that has not started are `upcoming`.
   */
  available: CreditAmountString;
  /** The part of `available` the user may spend now. */
  usable: CreditAmountString;
  /** Credits reserved by unfinished makeup sessions (part of `usable`). */
  reserved: CreditAmountString;
  /** Usable credits that can start a new makeup session. */
  free: CreditAmountString;
  upcoming: CreditAmountString;
  /** Ever granted, spent and expired (history, all sources). */
  granted: CreditAmountString;
  used: CreditAmountString;
  expired: CreditAmountString;
  /** Session overage used in total (beyond the balance; not repaid). */
  overageUsed: CreditAmountString;
  nextExpiration: {
    expiresAt: string;
    amount: CreditAmountString;
    sources: CreditSource[];
  } | null;
  /** Every source (TRIAL, SUBSCRIPTION, PURCHASE, REFERRAL, DAILY_REWARD). */
  sources: CreditSourceBalanceView[];
  /** Every allocation, newest first. */
  allocations: CreditAccountAllocationView[];
  asOf: string;
}

/** Transaction types of the history. */
export type CreditHistoryType = 'ALLOCATION' | 'DEDUCTION' | 'EXPIRATION';

/** Overage is not a credit source but is shown as one in a deduction. */
export const SESSION_OVERAGE_SOURCE = 'SESSION_OVERAGE';

export interface CreditHistorySourceView {
  source: CreditSource | typeof SESSION_OVERAGE_SOURCE;
  /** Signed: positive for an allocation, negative otherwise. */
  amount: CreditAmountString;
  allocationId: string | null;
  expiresAt: string | null;
}

export interface CreditHistoryUsageView {
  id: string;
  runId: string;
  operation: AiOperation;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: CreditAmountString | null;
  /** The conversion rate used: USD micros per credit, and as USD. */
  creditCostUsdMicros: number | null;
  creditCostUsd: string | null;
  creditsDue: CreditAmountString | null;
  creditsCharged: CreditAmountString | null;
}

export interface CreditHistoryItemView {
  id: string;
  /** Ledger order (cursor for `before`). */
  sequence: string;
  type: CreditHistoryType;
  /** Signed change to the balance. */
  amount: CreditAmountString;
  /** DEDUCTION: credits covered by the session overage allowance. */
  overageAmount: CreditAmountString;
  /** DEDUCTION: balance part + overage; null otherwise. */
  creditsCharged: CreditAmountString | null;
  balanceAfter: CreditAmountString;
  /**
   * The credit source; for a deduction spread over several sources (or
   * with overage) `MIXED`, see `sources`.
   */
  source: CreditSource | typeof SESSION_OVERAGE_SOURCE | 'MIXED' | null;
  sources: CreditHistorySourceView[];
  description: string | null;
  occurredAt: string;
  /** The makeup session of a deduction (kept after the session is deleted). */
  sessionId: string | null;
  /** The session if it still exists. */
  session: {
    id: string;
    status: MakeupSessionStatus;
    createdAt: string;
  } | null;
  /** The AI request an AI deduction paid for. */
  aiUsage: CreditHistoryUsageView | null;
}

export interface CreditHistoryPageView {
  items: CreditHistoryItemView[];
  /** Pass as `before` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}
