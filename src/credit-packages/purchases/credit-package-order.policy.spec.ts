import type Stripe from 'stripe';
import {
  packageOrderCreditReference,
  verifyPackageCheckout,
} from './credit-package-order.policy';

const order = {
  id: 'order-1',
  amountUsdCents: 800,
  providerCustomerId: 'cus_1',
  providerSessionId: 'cs_1',
};

const intent = (overrides: Partial<Stripe.PaymentIntent> = {}) =>
  ({
    id: 'pi_1',
    object: 'payment_intent',
    status: 'succeeded',
    amount_received: 800,
    currency: 'usd',
    metadata: { creditPackageOrderId: 'order-1' },
    payment_method: {
      id: 'pm_1',
      card: { fingerprint: 'fp_card' },
    },
    ...overrides,
  }) as unknown as Stripe.PaymentIntent;

const session = (
  overrides: Partial<Record<keyof Stripe.Checkout.Session, unknown>> = {},
) =>
  ({
    id: 'cs_1',
    mode: 'payment',
    metadata: { creditPackageOrderId: 'order-1' },
    customer: 'cus_1',
    currency: 'usd',
    amount_total: 800,
    status: 'complete',
    payment_status: 'paid',
    payment_intent: intent(),
    ...overrides,
  }) as unknown as Stripe.Checkout.Session;

describe('credit package order policy', () => {
  it('accepts a collected payment of exactly the order amount for this order and customer', () => {
    expect(verifyPackageCheckout(session(), order)).toEqual({
      outcome: 'PAID',
      providerSessionId: 'cs_1',
      paymentIntentId: 'pi_1',
      amountCents: 800,
      paymentMethodFingerprint: 'fp_card',
    });
  });

  it.each([
    ['another mode', { mode: 'subscription' }, 'NOT_A_PAYMENT_CHECKOUT'],
    [
      'another order',
      { metadata: { creditPackageOrderId: 'x' } },
      'ORDER_MISMATCH',
    ],
    ['no order', { metadata: {} }, 'ORDER_MISMATCH'],
    ['another session', { id: 'cs_2' }, 'SESSION_MISMATCH'],
    ['another customer', { customer: 'cus_2' }, 'CUSTOMER_MISMATCH'],
    ['another currency', { currency: 'eur' }, 'CURRENCY_MISMATCH'],
    ['another amount', { amount_total: 100 }, 'AMOUNT_MISMATCH'],
    ['no PaymentIntent', { payment_intent: null }, 'PAYMENT_INTENT_MISSING'],
    [
      'an unexpanded PaymentIntent',
      { payment_intent: 'pi_1' },
      'PAYMENT_INTENT_MISSING',
    ],
    [
      'a failed PaymentIntent',
      { payment_intent: intent({ status: 'requires_payment_method' }) },
      'PAYMENT_NOT_SUCCEEDED',
    ],
    [
      'a partial collection',
      { payment_intent: intent({ amount_received: 500 }) },
      'PAYMENT_AMOUNT_MISMATCH',
    ],
    [
      "another order's PaymentIntent",
      { payment_intent: intent({ metadata: { creditPackageOrderId: 'x' } }) },
      'PAYMENT_ORDER_MISMATCH',
    ],
    [
      'no payment required',
      { payment_status: 'no_payment_required' },
      'NOT_PAID',
    ],
  ])('rejects %s', (_, overrides, reason) => {
    expect(verifyPackageCheckout(session(overrides), order)).toEqual({
      outcome: 'REJECTED',
      reason,
    });
  });

  it.each(['open', 'expired'])('grants nothing for a %s session', (status) => {
    expect(
      verifyPackageCheckout(
        session({ status, payment_status: 'unpaid', payment_intent: null }),
        order,
      ),
    ).toEqual({ outcome: 'NOT_PAID' });
  });

  it('waits for delayed payments that have not settled', () => {
    expect(
      verifyPackageCheckout(session({ payment_status: 'unpaid' }), order),
    ).toEqual({ outcome: 'AWAITING_PAYMENT', providerSessionId: 'cs_1' });
    expect(
      verifyPackageCheckout(
        session({ payment_intent: intent({ status: 'processing' }) }),
        order,
      ),
    ).toEqual({ outcome: 'AWAITING_PAYMENT', providerSessionId: 'cs_1' });
  });

  it('accepts the session of an order whose session id was not stored yet', () => {
    expect(
      verifyPackageCheckout(session(), { ...order, providerSessionId: null })
        .outcome,
    ).toBe('PAID');
  });

  it('references order credits by order', () => {
    expect(packageOrderCreditReference('o1')).toBe('credit-package:o1');
  });
});
