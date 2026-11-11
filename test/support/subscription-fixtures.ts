import {
  BillingInterval,
  PaymentStatus,
  PrismaClient,
  SubscriptionStatus,
  userStatus,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { addBillingInterval } from '../../src/subscription/billing.validation';

/**
 * Test fixtures for subscription states. The payment system does not exist
 * yet, so purchases are written directly, but always through a SUCCEEDED
 * PaymentTransaction (the database rejects a paid term without one).
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const daysFrom = (date: Date, days: number) =>
  new Date(date.getTime() + days * DAY_MS);

export async function createUser(
  client: PrismaClient,
  status: userStatus = userStatus.ACTIVE,
  account: { verified?: boolean; deletedAt?: Date | null } = {},
): Promise<string> {
  const tag = randomBytes(6).toString('hex');
  const user = await client.authUser.create({
    data: {
      email: `${tag}@example.com`,
      username: `user_${tag}`,
      password: 'not-a-real-hash',
      verified: account.verified ?? true,
      deletedAt: account.deletedAt ?? null,
      status,
    },
  });
  return user.id;
}

export interface PaidTermFixture {
  billingInterval: BillingInterval;
  startedAt: Date;
  /** Defaults to the calendar expiry: one month or year after startedAt. */
  expiresAt?: Date;
  canceledAt?: Date;
}

/** The calendar expiry of a paid term (one billing period). */
export const termEnd = (term: PaidTermFixture): Date =>
  term.expiresAt ?? addBillingInterval(term.startedAt, term.billingInterval);

/** Default plan prices, in cents, by interval. */
export const DEFAULT_PRICE_CENTS: Record<BillingInterval, number> = {
  MONTHLY: 1900,
  YEARLY: 19000,
};

export interface PaymentFixture {
  status?: PaymentStatus;
  billingInterval?: BillingInterval;
  periodStart: Date;
  periodEnd: Date;
  amountCents?: number;
  provider?: string;
  providerPaymentId?: string;
}

/**
 * Records a payment in a consistent state for its status (timestamps and
 * refund amounts as the database requires).
 */
export async function recordPayment(
  client: PrismaClient,
  subscriptionId: string,
  payment: PaymentFixture,
) {
  const status = payment.status ?? PaymentStatus.SUCCEEDED;
  const billingInterval = payment.billingInterval ?? BillingInterval.MONTHLY;
  const amountCents =
    payment.amountCents ?? DEFAULT_PRICE_CENTS[billingInterval];
  const paid =
    status !== PaymentStatus.PENDING && status !== PaymentStatus.FAILED;
  return client.paymentTransaction.create({
    data: {
      subscriptionId,
      provider: payment.provider ?? 'test-provider',
      providerPaymentId:
        payment.providerPaymentId ?? `pay_${randomBytes(8).toString('hex')}`,
      status,
      amountCents,
      billingInterval,
      periodStart: payment.periodStart,
      periodEnd: payment.periodEnd,
      paidAt: paid ? payment.periodStart : null,
      failedAt: status === PaymentStatus.FAILED ? payment.periodStart : null,
      failureCode: status === PaymentStatus.FAILED ? 'card_declined' : null,
      refundedAmountCents:
        status === PaymentStatus.REFUNDED
          ? amountCents
          : status === PaymentStatus.PARTIALLY_REFUNDED
            ? Math.floor(amountCents / 2)
            : 0,
      refundedAt:
        status === PaymentStatus.REFUNDED ||
        status === PaymentStatus.PARTIALLY_REFUNDED
          ? payment.periodStart
          : null,
    },
  });
}

/**
 * A completed, verified Pro purchase on an existing record, done the way the
 * future payment flow must do it: a SUCCEEDED payment for the period, then
 * the paid term (trial fields untouched), then a CREATED/RENEWED event.
 */
export async function givenProPurchased(
  client: PrismaClient,
  authId: string,
  term: PaidTermFixture,
  status: SubscriptionStatus = SubscriptionStatus.PRO,
) {
  const current = await client.userSubscription.findUniqueOrThrow({
    where: { authId },
  });
  const expiresAt = termEnd(term);
  const payment = await recordPayment(client, current.id, {
    billingInterval: term.billingInterval,
    periodStart: term.startedAt,
    periodEnd: expiresAt,
  });
  const updated = await client.userSubscription.update({
    where: { authId },
    data: {
      status,
      billingInterval: term.billingInterval,
      proStartedAt: term.startedAt,
      proExpiresAt: expiresAt,
      proCanceledAt: term.canceledAt ?? null,
    },
  });
  await client.subscriptionEvent.create({
    data: {
      subscriptionId: current.id,
      type: current.proStartedAt ? 'RENEWED' : 'CREATED',
      paymentId: payment.id,
      occurredAt: term.startedAt,
    },
  });
  if (term.canceledAt) {
    await client.subscriptionEvent.create({
      data: {
        subscriptionId: current.id,
        type: 'CANCELED',
        occurredAt: term.canceledAt,
      },
    });
  }
  return updated;
}

/** A renewal: a SUCCEEDED payment for the next period extends the term. */
export async function givenProRenewed(
  client: PrismaClient,
  authId: string,
  renewal: {
    billingInterval: BillingInterval;
    periodStart: Date;
    /** Defaults to the calendar expiry of periodStart. */
    periodEnd?: Date;
  },
) {
  const period = {
    ...renewal,
    periodEnd:
      renewal.periodEnd ??
      addBillingInterval(renewal.periodStart, renewal.billingInterval),
  };
  const current = await client.userSubscription.findUniqueOrThrow({
    where: { authId },
  });
  const payment = await recordPayment(client, current.id, period);
  const updated = await client.userSubscription.update({
    where: { authId },
    data: {
      status: SubscriptionStatus.PRO,
      billingInterval: period.billingInterval,
      proExpiresAt: period.periodEnd,
    },
  });
  await client.subscriptionEvent.create({
    data: {
      subscriptionId: current.id,
      type: 'RENEWED',
      paymentId: payment.id,
      occurredAt: period.periodStart,
    },
  });
  return updated;
}

/** A user who paid for Pro (verified payment) but never used the free trial. */
export async function givenPaidProHistory(
  client: PrismaClient,
  authId: string,
  term: PaidTermFixture,
  now: Date,
) {
  await client.userSubscription.create({ data: { authId } });
  const active =
    term.startedAt.getTime() <= now.getTime() &&
    now.getTime() < termEnd(term).getTime();
  return givenProPurchased(
    client,
    authId,
    term,
    active ? SubscriptionStatus.PRO : SubscriptionStatus.EXPIRED,
  );
}

/** A record that exists but has never been used (e.g. created by another flow). */
export async function givenFreeRecord(client: PrismaClient, authId: string) {
  return client.userSubscription.create({ data: { authId } });
}
