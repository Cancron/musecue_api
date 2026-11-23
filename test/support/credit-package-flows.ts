import { randomBytes } from 'node:crypto';
import { nextTestIp, type TestAccount } from './discount-fixtures';
import { dataOf, referralFlows, type ReferralApp } from './referral-flows';

export interface GiftView {
  id: string;
  role: 'sender' | 'recipient';
  status: string;
  sender: { id: string; username: string } | null;
  recipient: { id: string; username: string } | null;
  packageCode: string;
  credits: number;
  message: string | null;
  deliverAt: string;
  expiresAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
  listPriceUsdCents?: number;
  checkout?: {
    orderId: string;
    status: string;
    amountDueUsdCents: number;
    checkoutUrl: string | null;
  } | null;
  replayed?: boolean;
}

export interface OrderView {
  id: string;
  kind: string;
  giftId: string | null;
  status: string;
  packageCode: string;
  credits: number;
  listPriceUsdCents: number;
  discount: {
    source: string;
    percent: number;
    amountOffCents: number;
    code: string | null;
  } | null;
  amountDueUsdCents: number;
  checkoutUrl: string | null;
  paidAt: string | null;
  closedReason: string | null;
  replayed?: boolean;
}

/**
 * Credit package purchases through the complete application (HTTP, the
 * Stripe SDK against FakeStripeApi, signed webhooks), on top of
 * referralFlows.
 */
export function creditPackageFlows(app: ReferralApp) {
  const r = referralFlows(app);
  const newKey = () => `buy-${randomBytes(8).toString('hex')}`;

  const flows = {
    ...r,
    newKey,
    /** POST /v1/credit-packages/:code/checkout (raw response). */
    checkoutRequest: (
      account: TestAccount,
      code: string,
      options: { key?: string | null; discountCode?: string } = {},
    ) => {
      const req = r
        .http()
        .post(`/v1/credit-packages/${code}/checkout`)
        .set('X-Forwarded-For', nextTestIp())
        .set('Authorization', r.as(account));
      if (options.key !== null)
        req.set('Idempotency-Key', options.key ?? newKey());
      return req.send(
        options.discountCode ? { discountCode: options.discountCode } : {},
      );
    },
    /** Opens a purchase; returns the order. */
    orderPackage: async (
      account: TestAccount,
      code = 'SMALL',
      options: { key?: string; discountCode?: string } = {},
    ) =>
      dataOf<OrderView>(
        await flows.checkoutRequest(account, code, options).expect(201),
      ),
    sessionOf: async (orderId: string) =>
      (
        await app.ctx.client.creditPackageOrder.findUniqueOrThrow({
          where: { id: orderId },
        })
      ).providerSessionId as string,
    /** The customer pays on the Stripe page (no webhook yet). */
    payOrder: async (
      orderId: string,
      options: {
        paymentStatus?: 'paid' | 'unpaid';
        cardFingerprint?: string;
      } = {},
    ) => {
      const sessionId = await flows.sessionOf(orderId);
      app.stripe.api.completeSession(sessionId, options);
      return sessionId;
    },
    /** Order, payment and the verified `checkout.session.completed` webhook. */
    buyPackage: async (
      account: TestAccount,
      code = 'SMALL',
      options: { discountCode?: string; cardFingerprint?: string } = {},
    ) => {
      const order = await flows.orderPackage(account, code, options);
      if (order.status === 'PAID') return { order, sessionId: null };
      const sessionId = await flows.payOrder(order.id, {
        cardFingerprint: options.cardFingerprint,
      });
      await r.sessionEvent('checkout.session.completed', sessionId).expect(200);
      return { order, sessionId };
    },
    /** POST /v1/credit-package-gifts (raw response). */
    sendGiftRequest: (
      sender: TestAccount,
      body: Record<string, unknown>,
      key: string | null = newKey(),
    ) => {
      const req = r
        .http()
        .post('/v1/credit-package-gifts')
        .set('X-Forwarded-For', nextTestIp())
        .set('Authorization', r.as(sender));
      if (key !== null) req.set('Idempotency-Key', key);
      return req.send(body);
    },
    sendGift: async (
      sender: TestAccount,
      recipient: string,
      body: Record<string, unknown> = {},
    ) =>
      dataOf<GiftView>(
        await flows
          .sendGiftRequest(sender, { packageCode: 'SMALL', recipient, ...body })
          .expect(201),
      ),
    /** POST /v1/credit-package-gifts/:id/checkout (raw response). */
    giftCheckoutRequest: (
      sender: TestAccount,
      giftId: string,
      body: Record<string, unknown> = {},
      key: string = newKey(),
    ) =>
      r
        .http()
        .post(`/v1/credit-package-gifts/${giftId}/checkout`)
        .set('X-Forwarded-For', nextTestIp())
        .set('Authorization', r.as(sender))
        .set('Idempotency-Key', key)
        .send(body),
    /** Checkout, payment and webhook of an accepted gift; returns the order. */
    payGift: async (
      sender: TestAccount,
      giftId: string,
      options: { discountCode?: string } = {},
    ) => {
      const order = dataOf<OrderView>(
        await flows
          .giftCheckoutRequest(
            sender,
            giftId,
            options.discountCode ? { discountCode: options.discountCode } : {},
          )
          .expect(201),
      );
      if (order.status === 'PAID') return { order, sessionId: null };
      const sessionId = await flows.payOrder(order.id);
      await r.sessionEvent('checkout.session.completed', sessionId).expect(200);
      return { order, sessionId };
    },
    giftRow: (giftId: string) =>
      app.ctx.client.creditGift.findUniqueOrThrow({ where: { id: giftId } }),
    fulfillmentOf: (orderId: string) =>
      app.ctx.client.creditFulfillment.findUniqueOrThrow({
        where: { orderId },
        include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      }),
    /** GIFT credits of a user. */
    giftCredits: async (authId: string) =>
      (
        await app.ctx.client.creditAllocation.findMany({
          where: { authId, source: 'GIFT' },
          orderBy: { grantedAt: 'asc' },
        })
      ).map((a) => ({
        reference: a.sourceReference,
        amount: a.amount.toFixed(),
        expiresAt: a.expiresAt,
      })),
    orderRow: (orderId: string) =>
      app.ctx.client.creditPackageOrder.findUniqueOrThrow({
        where: { id: orderId },
      }),
    /** Credits granted by package orders. */
    packageCredits: async (authId: string) =>
      (
        await app.ctx.client.creditAllocation.findMany({
          where: {
            authId,
            source: 'PURCHASE',
            sourceReference: { startsWith: 'credit-package:' },
          },
          orderBy: { grantedAt: 'asc' },
        })
      ).map((a) => ({
        reference: a.sourceReference,
        amount: a.amount.toFixed(),
        expiresAt: a.expiresAt,
      })),
  };
  return flows;
}
