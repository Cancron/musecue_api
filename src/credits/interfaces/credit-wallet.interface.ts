import type { CreditSource, CreditTransactionType } from '@prisma/client';
import type { CreditAmountInput } from '../credit-amount';

/** Amounts in views are exact decimal strings (e.g. "12.5"). */
export type CreditAmountString = string;

export interface GrantCreditsInput {
  authId: string;
  source: CreditSource;
  /**
   * What the credits are granted for, unique per user and source, e.g.
   * `<subscriptionId>:<periodStart ISO>` for a monthly Pro allowance, or a
   * payment or referral ID. Granting the same reference again is a no-op.
   */
  sourceReference: string;
  amount: CreditAmountInput;
  /** Required for TRIAL and SUBSCRIPTION; must be omitted otherwise. */
  expiresAt?: Date | null;
  description?: string;
  /**
   * If this source event was already granted with a different amount or
   * expiry, return the existing grant instead of rejecting the repeat. For
   * allowances whose amount comes from settings that may change after the
   * first grant. Never grants twice either way.
   */
  keepExistingGrant?: boolean;
}

export interface DebitCreditsInput {
  authId: string;
  amount: CreditAmountInput;
  /** Unique per user: a retried debit with the same key is applied once. */
  idempotencyKey: string;
  /**
   * The caller's makeup session the credits are used for. Only debits for a
   * session may use the session overage allowance.
   */
  sessionId?: string;
  description?: string;
}

export interface CreditAllocationView {
  id: string;
  source: CreditSource;
  sourceReference: string;
  amount: CreditAmountString;
  remaining: CreditAmountString;
  grantedAt: string;
  expiresAt: string | null;
}

export interface CreditTransactionView {
  id: string;
  type: CreditTransactionType;
  /** Signed change to the available balance. */
  amount: CreditAmountString;
  overageAmount: CreditAmountString;
  balanceAfter: CreditAmountString;
  sessionId: string | null;
  description: string | null;
  occurredAt: string;
  entries: { allocationId: string; amount: CreditAmountString }[];
}

export interface GrantCreditsResult {
  allocation: CreditAllocationView;
  transaction: CreditTransactionView;
  /** True when the grant had already been applied (nothing new written). */
  replayed: boolean;
}

export interface DebitCreditsResult {
  transaction: CreditTransactionView;
  /** Credits taken from the balance. */
  consumed: CreditAmountString;
  /** Credits covered by the session overage allowance. */
  overage: CreditAmountString;
  replayed: boolean;
}

export interface CreditBalanceView {
  /** Unexpired remaining credits; expired credits never count. */
  available: CreditAmountString;
  bySource: Record<CreditSource, CreditAmountString>;
  /** The earliest upcoming expiry and the credits that expire then. */
  nextExpiration: { expiresAt: string; amount: CreditAmountString } | null;
  /** Allocations that still hold available credits, in spending order. */
  allocations: CreditAllocationView[];
  asOf: string;
}

export interface ExpireDueCreditsResult {
  /** Wallets with due expirations that were processed (or attempted). */
  wallets: number;
  expirations: number;
  /** Wallets whose expirations could not be recorded; retried next time. */
  failed: number;
}
