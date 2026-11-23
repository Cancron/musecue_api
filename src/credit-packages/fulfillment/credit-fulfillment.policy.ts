/**
 * Pure rules of credit fulfillment (no database access).
 */

/** Attempts before a fulfillment is FAILED (an administrator retries it). */
export const MAX_FULFILLMENT_ATTEMPTS = 5;

/** Delay before the next attempt after `attempts` failed ones. */
export function retryDelayMs(attempts: number): number {
  const steps = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];
  return steps[Math.min(Math.max(attempts, 1), steps.length) - 1];
}

/** The credit reference of a gift's GIFT credits. */
export const giftCreditReference = (giftId: string) => `credit-gift:${giftId}`;

/** Why a paid order's credits wait for an administrator. */
export type FulfillmentHoldReason =
  /** The gift recipient's account is unverified. */
  | 'RECIPIENT_UNVERIFIED'
  /** Not active: suspended, blocked, inactive or pending deletion. */
  | 'RECIPIENT_INACTIVE'
  /** The receiving account was deleted. */
  | 'RECIPIENT_DELETED'
  /** A payment for a gift that was declined, expired or canceled meanwhile. */
  | 'GIFT_NOT_PAYABLE'
  /** A second payment for a gift that was already paid. */
  | 'GIFT_ALREADY_PAID';

/**
 * Whether an account can receive credits now: it exists, its email is
 * verified and it is ACTIVE (not suspended, blocked, inactive, pending
 * deletion or deleted). Null when it can, otherwise the hold reason.
 */
export function recipientHoldReason(
  account: {
    verified: boolean;
    status: string;
    deletedAt: Date | null;
  } | null,
): FulfillmentHoldReason | null {
  if (!account || account.deletedAt !== null || account.status === 'DELETED') {
    return 'RECIPIENT_DELETED';
  }
  if (account.status !== 'ACTIVE') return 'RECIPIENT_INACTIVE';
  if (!account.verified) return 'RECIPIENT_UNVERIFIED';
  return null;
}

/** A short, non-sensitive code of an error (never its message). */
export function fulfillmentErrorCode(error: unknown): string {
  let code: string;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    code = `db:${(error as { code: string }).code}`;
  } else if (error instanceof Error) {
    code = error.name;
  } else {
    code = 'unknown';
  }
  return code.slice(0, 100);
}
