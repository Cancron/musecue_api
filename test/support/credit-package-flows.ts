import { randomBytes } from 'node:crypto';
import { nextTestIp, type TestAccount } from './discount-fixtures';
import { dataOf, referralFlows, type ReferralApp } from './referral-flows';

export interface OrderView {
  id: string;
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
