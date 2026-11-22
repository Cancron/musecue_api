import { userRole } from '@prisma/client';
import request from 'supertest';
import { UserRole } from '../../src/auth/interfaces/auth.interface';
import type { FakeStripeApi } from './fake-stripe-api';
import type { StripeTestApp } from './stripe-test-app';
import { createUser } from './subscription-fixtures';

/**
 * Helpers for the e2e tests of discounts in the Stripe checkout: the real
 * HTTP routes (checkout, webhooks, discount administration, referrals) of a
 * StripeTestApp created with DiscountsModule, and FakeStripeApi standing in
 * for Stripe.
 */

export interface CheckoutView {
  checkoutSessionId: string;
  status: string;
  billingInterval: string;
  amountCents: number;
  amountDueCents: number;
  discount: {
    source: string;
    percent: number;
    amountOffCents: number;
    code?: string;
    offerId?: string;
  } | null;
  url: string;
  reused: boolean;
}

export const dataOf = <T>(response: { body: unknown }) =>
  (response.body as { data: T }).data;
export const messageOf = (response: { body: unknown }) =>
  (response.body as { message: string }).message;

export function discountCheckout(harness: StripeTestApp) {
  const http = () => request(harness.app.getHttpServer());
  const api = (): FakeStripeApi => harness.stripe.api;

  const helpers = {
    http,
    /** A verified, active USER account. */
    user: () => createUser(harness.client),
    /** An ADMIN account. */
    admin: async () => {
      const id = await createUser(harness.client);
      await harness.client.authUser.update({
        where: { id },
        data: { role: userRole.ADMIN },
      });
      return id;
    },
    asAdmin: (adminId: string) => harness.bearer(adminId, UserRole.ADMIN),

    /** PATCH /v1/admin/discount-settings. */
    setDiscountSettings: (adminId: string, body: Record<string, number>) =>
      http()
        .patch('/v1/admin/discount-settings')
        .set('Authorization', helpers.asAdmin(adminId))
        .send(body)
        .expect(200),
    createOffer: async (
      adminId: string,
      kind: 'codes' | 'campaigns',
      body: Record<string, unknown>,
    ) =>
      dataOf<OfferView>(
        await http()
          .post(`/v1/admin/discount-${kind}`)
          .set('Authorization', helpers.asAdmin(adminId))
          .send(body)
          .expect(201),
      ),
    getOffer: async (
      adminId: string,
      kind: 'codes' | 'campaigns',
      id: string,
    ) =>
      dataOf<OfferView>(
        await http()
          .get(`/v1/admin/discount-${kind}/${id}`)
          .set('Authorization', helpers.asAdmin(adminId))
          .expect(200),
      ),
    patchOffer: (
      adminId: string,
      kind: 'codes' | 'campaigns',
      id: string,
      body: Record<string, unknown>,
    ) =>
      http()
        .patch(`/v1/admin/discount-${kind}/${id}`)
        .set('Authorization', helpers.asAdmin(adminId))
        .send(body),

    /** POST /v1/subscription/checkout (with an optional discount code). */
    checkout: (
      userId: string,
      billingInterval = 'MONTHLY',
      discountCode?: string,
    ) =>
      http()
        .post('/v1/subscription/checkout')
        .set('Authorization', harness.bearer(userId))
        .send(
          discountCode === undefined
            ? { billingInterval }
            : { billingInterval, discountCode },
        ),
    /** A checkout that must succeed. */
    open: async (
      userId: string,
      billingInterval = 'MONTHLY',
      discountCode?: string,
    ) =>
      dataOf<CheckoutView>(
        await helpers
          .checkout(userId, billingInterval, discountCode)
          .expect(201),
      ),

    row: (checkoutId: string) =>
      harness.client.checkoutSession.findUniqueOrThrow({
        where: { id: checkoutId },
      }),
    sessionId: async (checkoutId: string) =>
      (await helpers.row(checkoutId)).providerSessionId as string,
    redemption: (checkoutId: string) =>
      harness.client.discountRedemption.findUnique({
        where: { checkoutSessionId: checkoutId },
      }),

    sendSessionEvent: (type: string, sessionId: string) => {
      const { payload, signature } = api().signedEvent(type, sessionId);
      return harness.sendWebhook(payload, signature);
    },
    sendInvoiceEvent: (type: string, invoiceId: string) => {
      const { payload, signature } = api().signedInvoiceEvent(type, invoiceId);
      return harness.sendWebhook(payload, signature);
    },
    sendSubscriptionEvent: (type: string, subscriptionId: string) => {
      const { payload, signature } = api().signedSubscriptionEvent(
        type,
        subscriptionId,
      );
      return harness.sendWebhook(payload, signature);
    },

    /** The customer pays on the hosted page; the verified webhook records it. */
    pay: async (
      checkoutId: string,
      options: { invoiceAmount?: number } = {},
    ) => {
      const sessionId = await helpers.sessionId(checkoutId);
      api().completeSession(sessionId, options);
      await helpers
        .sendSessionEvent('checkout.session.completed', sessionId)
        .expect(200);
      return api().sessions.get(sessionId) as Record<string, unknown>;
    },
    /** The hosted page is abandoned until Stripe expires the session. */
    abandon: async (checkoutId: string) => {
      const sessionId = await helpers.sessionId(checkoutId);
      api().expireByTime(sessionId);
      await helpers
        .sendSessionEvent('checkout.session.expired', sessionId)
        .expect(200);
    },
  };
  return helpers;
}

export interface OfferView {
  id: string;
  code?: string;
  discountPercent: number;
  status: string;
  redemptionCount: number;
  reservedRedemptions: number;
  redeemedRedemptions: number;
  remainingRedemptions: number | null;
  budgetCents: number | null;
  budgetSpentCents: number;
  budgetReservedCents: number;
  budgetRemainingCents: number | null;
}
