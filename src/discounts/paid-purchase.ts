import {
  CreditPackageOrderStatus,
  PaymentStatus,
  type Prisma,
} from '@prisma/client';

/**
 * Payments that make a purchase "paid": collected, even if refunded later
 * (a refund does not make the first-purchase discount available again).
 * Failed or pending payments, abandoned checkouts and free trials do not.
 */
export const PAID_PURCHASE_STATUSES: PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

/**
 * Whether the user ever made a successful paid purchase: a collected Pro
 * payment or a PAID credit package order. Until then the first-purchase and
 * referral discounts stay available, and the user is a new customer for
 * campaign targeting. (PostgreSQL applies the same rule:
 * musecue_has_paid_purchase.)
 */
export async function hasPaidPurchase(
  client: Prisma.TransactionClient,
  authId: string,
): Promise<boolean> {
  const paid = await client.paymentTransaction.findFirst({
    where: {
      status: { in: PAID_PURCHASE_STATUSES },
      subscription: { authId },
    },
    select: { id: true },
  });
  if (paid) return true;
  const order = await client.creditPackageOrder.findFirst({
    where: { authId, status: CreditPackageOrderStatus.PAID },
    select: { id: true },
  });
  return order !== null;
}
