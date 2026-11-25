import type {
  BillingInterval,
  CreditSource,
  CreditTransactionType,
} from '@prisma/client';
import type { CreditAmountInput } from '../credit-ledger.policy';

/** Credit amounts are exact decimal strings, e.g. "12.5" or "0.000125". */
export type CreditAmountString = string;

export interface AllocateCreditsInput {
  authId: string;
  source: CreditSource;
  /**
   * Identifies the granting event, e.g. `trial:<subscriptionId>`,
   * `pro:<subscriptionId>:<periodStart>`, a payment or referral ID. Globally
   * unique per source: repeating the same allocation is a no-op.
   */
  sourceReference: string;
  /** Positive, at most 6 decimal places. */
  credits: CreditAmountInput;
  /** Required for TRIAL and SUBSCRIPTION, not allowed for PURCHASE and REFERRAL. */
  expiresAt?: Date | null;
  /** Defaults to the current time; exposed for deterministic tests. */
  now?: Date;
}

/** The credits of one paid Pro period (see allocateSubscriptionCredits). */
export interface SubscriptionCreditsInput {
  authId: string;
  subscriptionId: string;
  /** The SUCCEEDED PaymentTransaction that paid for the period. */
  paymentId: string;
  periodStart: Date;
  /** The billing boundary: the credits expire here. */
  periodEnd: Date;
  credits: CreditAmountInput;
  now?: Date;
}

/** A recorded successful payment, for the monthly Pro allowance. */
export interface ProMonthlyCreditsInput {
  authId: string;
  subscriptionId: string;
  payment: {
    id: string;
    billingInterval: BillingInterval;
    periodStart: Date;
    periodEnd: Date;
  };
  now?: Date;
}

export interface DeductCreditsInput {
  authId: string;
  /** Positive, at most 6 decimal places. */
  credits: CreditAmountInput;
  /** Unique per user; repeating a deduction with the same key is a no-op. */
  idempotencyKey: string;
  /** The user's makeup session; enables that session's overage allowance. */
  sessionId?: string;
  /** Caller reference stored with the transaction, e.g. an AI run ID. */
  reference?: string;
  now?: Date;
}

export interface CreditAllocationView {
  id: string;
  source: CreditSource;
  sourceReference: string;
  grantedCredits: CreditAmountString;
  remainingCredits: CreditAmountString;
  expiresAt: string | null;
  expiredAt: string | null;
  grantedAt: string;
  /** SUBSCRIPTION credits only: the paid Pro period they belong to. */
  subscriptionId: string | null;
  paymentId: string | null;
  /** Start of the paid period; it ends at `expiresAt`. */
  periodStartsAt: string | null;
}

export interface CreditTransactionView {
  id: string;
  sequence: number;
  type: CreditTransactionType;
  amountCredits: CreditAmountString;
  overageChangeCredits: CreditAmountString;
  balanceAfterCredits: CreditAmountString;
  outstandingOverageAfterCredits: CreditAmountString;
  allocationId: string | null;
  sessionId: string | null;
  reference: string | null;
  effectiveAt: string;
  createdAt: string;
  entries: { allocationId: string; amountCredits: CreditAmountString }[];
}

export interface CreditBalanceView {
  /** Unused credits that have not expired (expired credits never count). */
  availableCredits: CreditAmountString;
  availableBySource: Record<CreditSource, CreditAmountString>;
  /** Session overage used beyond the balance and not yet repaid. */
  outstandingOverageCredits: CreditAmountString;
  /** The earliest expiry among available credits, and how many expire then. */
  nextExpiration: { expiresAt: string; credits: CreditAmountString } | null;
}

export interface AllocationResult {
  /** False when the same allocation already existed (idempotent repeat). */
  created: boolean;
  allocation: CreditAllocationView;
}

export interface DeductionResult {
  /** True when the idempotency key was already used for this deduction. */
  duplicate: boolean;
  transaction: CreditTransactionView;
}

export interface ExpirationSweepResult {
  /** Wallets with due allocations that this batch processed. */
  wallets: number;
  expiredAllocations: number;
  /** Wallets whose expiry failed (retried by the next sweep). */
  failedWallets: number;
}
