import { SubscriptionStatus, type UserSubscription } from '@prisma/client';
import type { SubscriptionPlanSettings } from './interfaces/subscription-plan.interface';

/**
 * The single source of truth for Pro access and trial eligibility.
 *
 * Access is derived from the trial and Pro date windows, never from the stored
 * `status` alone, so an expiry takes effect at the exact moment it passes even
 * if nothing has rewritten the record yet. Windows are half-open:
 * access runs from `startedAt` (inclusive) to `expiresAt` (exclusive).
 */

export type SubscriptionRecord = Pick<
  UserSubscription,
  | 'trialUsed'
  | 'trialStartedAt'
  | 'trialExpiresAt'
  | 'billingInterval'
  | 'proStartedAt'
  | 'proExpiresAt'
  | 'proCanceledAt'
>;

export type AccessSource = 'TRIAL' | 'PRO';

export interface SubscriptionAccess {
  /** Effective status at `now` (may differ from the stored snapshot). */
  status: SubscriptionStatus;
  hasProAccess: boolean;
  /** Which subscription grants access; PRO wins when both are active. */
  accessSource: AccessSource | null;
  /** When access ends if nothing is renewed; null without access. */
  accessExpiresAt: Date | null;
}

const isWithin = (
  startedAt: Date | null,
  expiresAt: Date | null,
  now: Date,
): expiresAt is Date =>
  startedAt !== null &&
  expiresAt !== null &&
  startedAt.getTime() <= now.getTime() &&
  now.getTime() < expiresAt.getTime();

export function isTrialActive(
  record: SubscriptionRecord | null,
  now: Date,
): boolean {
  return (
    record !== null &&
    isWithin(record.trialStartedAt, record.trialExpiresAt, now)
  );
}

/** A canceled term stays active until it expires; it just won't renew. */
export function isProActive(
  record: SubscriptionRecord | null,
  now: Date,
): boolean {
  return (
    record !== null && isWithin(record.proStartedAt, record.proExpiresAt, now)
  );
}

export function resolveSubscriptionAccess(
  record: SubscriptionRecord | null,
  now: Date,
): SubscriptionAccess {
  const proActive = isProActive(record, now);
  const trialActive = isTrialActive(record, now);

  if (record && (proActive || trialActive)) {
    // Both windows contain `now`, so together they cover `now` up to the later expiry.
    const expiries = [
      proActive ? record.proExpiresAt : null,
      trialActive ? record.trialExpiresAt : null,
    ].filter((date): date is Date => date !== null);
    return {
      status: proActive ? SubscriptionStatus.PRO : SubscriptionStatus.TRIAL,
      hasProAccess: true,
      accessSource: proActive ? 'PRO' : 'TRIAL',
      accessExpiresAt: new Date(
        Math.max(...expiries.map((date) => date.getTime())),
      ),
    };
  }

  const hasHistory =
    record !== null &&
    (record.trialUsed ||
      record.trialStartedAt !== null ||
      record.proStartedAt !== null);
  return {
    status: hasHistory ? SubscriptionStatus.EXPIRED : SubscriptionStatus.FREE,
    hasProAccess: false,
    accessSource: null,
    accessExpiresAt: null,
  };
}

/** The account fields that decide whether a user may start a trial. */
export interface TrialAccount {
  status: string;
  verified: boolean;
  deletedAt: Date | null;
}

export const TRIAL_ACCOUNT_SELECT = {
  status: true,
  verified: true,
  deletedAt: true,
} as const satisfies Record<keyof TrialAccount, true>;

/**
 * Only an active account may start a trial: status ACTIVE, a verified email
 * and not soft-deleted. A still-valid access token is not enough on its own.
 */
export function isTrialAccountEligible(account: TrialAccount | null): boolean {
  return (
    account !== null &&
    account.status === 'ACTIVE' &&
    account.verified &&
    account.deletedAt === null
  );
}

export type TrialIneligibilityReason =
  | 'PLAN_DISABLED'
  | 'TRIAL_DISABLED'
  | 'TRIAL_ALREADY_USED'
  | 'HAS_PRO_HISTORY';

/**
 * The free trial is for users who have never had one and have never paid for
 * Pro. Any paid term on the record (active, canceled or expired) is history:
 * Pro fields are replaced on renewal but never cleared, so `proStartedAt`
 * being set means the user has paid before. The plan and its trial must also
 * be enabled.
 */
export function getTrialIneligibility(
  record: SubscriptionRecord | null,
  plan: Pick<SubscriptionPlanSettings, 'planEnabled' | 'trialEnabled'>,
): TrialIneligibilityReason | null {
  if (!plan.planEnabled) return 'PLAN_DISABLED';
  if (!plan.trialEnabled) return 'TRIAL_DISABLED';
  if (record === null) return null;
  if (record.trialUsed || record.trialStartedAt !== null) {
    return 'TRIAL_ALREADY_USED';
  }
  if (record.proStartedAt !== null) return 'HAS_PRO_HISTORY';
  return null;
}

export function canStartTrial(
  record: SubscriptionRecord | null,
  plan: Pick<SubscriptionPlanSettings, 'planEnabled' | 'trialEnabled'>,
): boolean {
  return getTrialIneligibility(record, plan) === null;
}
