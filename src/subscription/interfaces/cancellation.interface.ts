import type { SubscriptionStatus } from '@prisma/client';

/** The caller's subscription after a cancellation request. */
export interface SubscriptionCancellationView {
  /** Evaluated at request time: still PRO until the paid period ends. */
  status: SubscriptionStatus;
  hasProAccess: boolean;
  /** Always false: the subscription will not renew. */
  autoRenew: false;
  /** When the cancellation was requested. */
  canceledAt: string;
  /** End of the paid period; Pro features stay available until then. */
  endsAt: string;
  /** When Pro access ends (same rules as GET /v1/subscription). */
  accessExpiresAt: string | null;
  /** True when the subscription had already been canceled before. */
  alreadyCanceled: boolean;
}
