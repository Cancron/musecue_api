import type { BillingInterval, SubscriptionStatus } from '@prisma/client';
import type {
  AccessSource,
  TrialIneligibilityReason,
} from '../subscription-access.policy';

/** Why the caller cannot start the free trial right now. */
export type TrialEligibilityReason =
  | 'ACCOUNT_INACTIVE'
  | TrialIneligibilityReason;

/** The caller's own subscription, evaluated at request time. */
export interface SubscriptionStatusView {
  /** Derived from the dates at request time, not from the stored status. */
  status: SubscriptionStatus;
  hasProAccess: boolean;
  accessSource: AccessSource | null;
  accessExpiresAt: string | null;
  trial: {
    eligible: boolean;
    ineligibleReason: TrialEligibilityReason | null;
    used: boolean;
    active: boolean;
    startedAt: string | null;
    expiresAt: string | null;
  };
  pro: {
    active: boolean;
    billingInterval: BillingInterval | null;
    startedAt: string | null;
    expiresAt: string | null;
    canceledAt: string | null;
  };
}
