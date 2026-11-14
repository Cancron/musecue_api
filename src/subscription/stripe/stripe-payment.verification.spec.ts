import { BillingInterval } from '@prisma/client';
import type Stripe from 'stripe';
import {
  FAKE_WEBHOOK_SECRET,
  FakeStripeApi,
} from '../../../test/support/fake-stripe-api';
import {
  type ExpectedCheckout,
  type ExpectedInvoice,
  type ExpectedRenewal,
  verifyStripeCheckout,
  verifyStripeInvoice,
  verifyStripeRenewal,
} from './stripe-payment.verification';
import { StripeGateway } from './stripe.gateway';

type Session = Stripe.Checkout.Session;

describe('verifyStripeCheckout', () => {
  const periodStart = new Date('2026-01-31T10:00:00.000Z');
  let expected: ExpectedCheckout;
  let paidSession: Session;

  /** A completed checkout, read back from Stripe exactly as the webhook does. */
  async function completedCheckout(
    interval: BillingInterval,
    amountCents: number,
    payment: Parameters<FakeStripeApi['completeSession']>[1] = {},
  ) {
    const api = new FakeStripeApi();
    const gateway = new StripeGateway(
      {
        secretKey: 'sk_test_fake',
        webhookSecret: FAKE_WEBHOOK_SECRET,
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
        productId: null,
        checkoutExpiresMinutes: 60,
      },
      api.client(),
    );
    const customerId = await gateway.createCustomer('user-1', 'u@example.com');
    const session = await gateway.createCheckoutSession({
      checkoutId: 'checkout-1',
      authId: 'user-1',
      customerId,
      billingInterval: interval,
      amountCents,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    api.completeSession(session.id, { periodStart, ...payment });
    const checkout: ExpectedCheckout = {
      id: 'checkout-1',
      providerSessionId: session.id,
      providerCustomerId: customerId,
      billingInterval: interval,
      amountCents,
      currency: 'USD',
    };
    return {
      checkout,
      session: await gateway.retrieveCheckoutForVerification(session.id),
    };
  }

  /** A deep copy with one change applied, so every case starts valid. */
  const changed = (mutate: (session: Session) => void): Session => {
    const copy = structuredClone(paidSession);
    mutate(copy);
    return copy;
  };
  const subscriptionOf = (session: Session) =>
    session.subscription as Stripe.Subscription;
  const invoiceOf = (session: Session) => session.invoice as Stripe.Invoice;

  beforeEach(async () => {
    ({ checkout: expected, session: paidSession } = await completedCheckout(
      BillingInterval.MONTHLY,
      1900,
    ));
  });

  it('accepts a paid checkout and returns the payment to record', () => {
    expect(verifyStripeCheckout(paidSession, expected)).toEqual({
      outcome: 'PAID',
      payment: {
        providerSessionId: paidSession.id,
        providerPaymentId: invoiceOf(paidSession).id,
        providerSubscriptionId: subscriptionOf(paidSession).id,
        amountCents: 1900,
        currency: 'USD',
        billingInterval: 'MONTHLY',
        periodStart,
        // Stripe's own period end: Jan 31 anchors to Feb 28.
        periodEnd: new Date('2026-02-28T10:00:00.000Z'),
        paidAt: expect.any(Date) as Date,
      },
    });
  });

  it('accepts a paid yearly checkout with a yearly period', async () => {
    const yearly = await completedCheckout(BillingInterval.YEARLY, 19000);
    const result = verifyStripeCheckout(yearly.session, yearly.checkout);
    expect(result).toMatchObject({
      outcome: 'PAID',
      payment: {
        billingInterval: 'YEARLY',
        amountCents: 19000,
        periodEnd: new Date('2027-01-31T10:00:00.000Z'),
      },
    });
  });

  it('waits when the session completed with a payment that has not settled', async () => {
    const delayed = await completedCheckout(BillingInterval.MONTHLY, 1900, {
      paymentStatus: 'unpaid',
    });
    expect(verifyStripeCheckout(delayed.session, delayed.checkout)).toEqual({
      outcome: 'AWAITING_PAYMENT',
    });
  });

  it('falls back to the subscription latest invoice when the session has none', () => {
    const session = changed((s) => {
      s.invoice = null;
    });
    expect(verifyStripeCheckout(session, expected)).toMatchObject({
      outcome: 'PAID',
    });
  });

  it.each<[string, (session: Session) => void, string]>([
    [
      'another Stripe session id',
      (s) => (s.id = 'cs_test_other'),
      'SESSION_MISMATCH',
    ],
    [
      'another checkout in the metadata',
      (s) => (s.metadata = { checkoutSessionId: 'checkout-2' }),
      'SESSION_MISMATCH',
    ],
    [
      'a one-time payment',
      (s) => (s.mode = 'payment'),
      'NOT_SUBSCRIPTION_MODE',
    ],
    [
      'a session that is still open',
      (s) => (s.status = 'open'),
      'NOT_COMPLETE',
    ],
    ['a session that expired', (s) => (s.status = 'expired'), 'NOT_COMPLETE'],
    [
      "another user's customer",
      (s) => (s.customer = 'cus_other'),
      'CUSTOMER_MISMATCH',
    ],
    [
      'no payment collected (100% discount or trial)',
      (s) => (s.payment_status = 'no_payment_required'),
      'NO_PAYMENT_COLLECTED',
    ],
    ['another currency', (s) => (s.currency = 'eur'), 'CURRENCY_MISMATCH'],
    ['a lower total', (s) => (s.amount_total = 100), 'AMOUNT_MISMATCH'],
    ['no subscription', (s) => (s.subscription = null), 'SUBSCRIPTION_MISSING'],
    [
      'an unexpanded subscription',
      (s) => (s.subscription = 'sub_123'),
      'SUBSCRIPTION_MISSING',
    ],
    [
      'an incomplete subscription',
      (s) => (subscriptionOf(s).status = 'incomplete'),
      'SUBSCRIPTION_NOT_PAID',
    ],
    [
      'a subscription of another customer',
      (s) => (subscriptionOf(s).customer = 'cus_other'),
      'SUBSCRIPTION_NOT_PAID',
    ],
    [
      'a different subscription price',
      (s) => (subscriptionOf(s).items.data[0].price.unit_amount = 100),
      'PRICE_MISMATCH',
    ],
    [
      'the other billing interval',
      (s) => {
        const recurring = subscriptionOf(s).items.data[0].price.recurring;
        if (recurring) recurring.interval = 'year';
      },
      'PRICE_MISMATCH',
    ],
    [
      'a multi-month interval',
      (s) => {
        const recurring = subscriptionOf(s).items.data[0].price.recurring;
        if (recurring) recurring.interval_count = 3;
      },
      'PRICE_MISMATCH',
    ],
    [
      'a quantity above one',
      (s) => (subscriptionOf(s).items.data[0].quantity = 2),
      'PRICE_MISMATCH',
    ],
    [
      'an extra subscription item',
      (s) => subscriptionOf(s).items.data.push(subscriptionOf(s).items.data[0]),
      'PRICE_MISMATCH',
    ],
    [
      'no invoice at all',
      (s) => {
        s.invoice = null;
        subscriptionOf(s).latest_invoice = null;
      },
      'INVOICE_MISSING',
    ],
    [
      'a renewal invoice instead of the first one',
      (s) => (invoiceOf(s).billing_reason = 'subscription_cycle'),
      'INVOICE_NOT_INITIAL',
    ],
    [
      'an invoice of another subscription',
      (s) => {
        const details = invoiceOf(s).parent?.subscription_details;
        if (details) details.subscription = 'sub_other';
      },
      'INVOICE_NOT_INITIAL',
    ],
    [
      'an open invoice',
      (s) => (invoiceOf(s).status = 'open'),
      'INVOICE_NOT_PAID',
    ],
    [
      'a partially paid invoice',
      (s) => (invoiceOf(s).amount_paid = 1000),
      'INVOICE_NOT_PAID',
    ],
    [
      'an invoice in another currency',
      (s) => (invoiceOf(s).currency = 'eur'),
      'INVOICE_NOT_PAID',
    ],
    [
      'an invoice of another customer',
      (s) => (invoiceOf(s).customer = 'cus_other'),
      'INVOICE_NOT_PAID',
    ],
    [
      'an invoice without lines',
      (s) => (invoiceOf(s).lines.data = []),
      'INVALID_PERIOD',
    ],
    [
      'an empty period',
      (s) => {
        const period = invoiceOf(s).lines.data[0].period;
        period.end = period.start;
      },
      'INVALID_PERIOD',
    ],
  ])('rejects %s', (_label, mutate, reason) => {
    expect(verifyStripeCheckout(changed(mutate), expected)).toEqual({
      outcome: 'REJECTED',
      reason,
    });
  });

  it('uses the period dates exactly as Stripe reports them', () => {
    // Anchored on the 31st: Stripe bills Apr 30 -> May 31 (not May 30).
    const session = changed((s) => {
      invoiceOf(s).lines.data[0].period = {
        start: Date.parse('2026-04-30T10:00:00Z') / 1000,
        end: Date.parse('2026-05-31T10:00:00Z') / 1000,
      };
    });
    expect(verifyStripeCheckout(session, expected)).toMatchObject({
      outcome: 'PAID',
      payment: {
        periodStart: new Date('2026-04-30T10:00:00.000Z'),
        periodEnd: new Date('2026-05-31T10:00:00.000Z'),
      },
    });
  });

  it.each([
    ['29 days from Mar 1', '2026-03-01T10:00:00Z', '2026-03-30T10:00:00Z'],
    ['two months', '2026-03-01T10:00:00Z', '2026-05-01T10:00:00Z'],
    ['a shifted time of day', '2026-04-30T10:00:00Z', '2026-05-31T11:00:00Z'],
  ])(
    'rejects a Stripe period that is not one billing month (%s)',
    (_l, from, to) => {
      const session = changed((s) => {
        invoiceOf(s).lines.data[0].period = {
          start: Date.parse(from) / 1000,
          end: Date.parse(to) / 1000,
        };
      });
      expect(verifyStripeCheckout(session, expected)).toEqual({
        outcome: 'REJECTED',
        reason: 'INVALID_PERIOD',
      });
    },
  );

  it('rejects a session whose stored checkout expects another price', () => {
    expect(
      verifyStripeCheckout(paidSession, { ...expected, amountCents: 2500 }),
    ).toEqual({ outcome: 'REJECTED', reason: 'AMOUNT_MISMATCH' });
  });

  it('rejects the yearly option paid at the monthly price', () => {
    expect(
      verifyStripeCheckout(paidSession, {
        ...expected,
        billingInterval: BillingInterval.YEARLY,
      }),
    ).toEqual({ outcome: 'REJECTED', reason: 'PRICE_MISMATCH' });
  });
});

describe('verifyStripeRenewal', () => {
  const anchor = new Date('2026-01-31T10:00:00.000Z');
  let api: FakeStripeApi;
  let expected: ExpectedRenewal;
  let invoice: Stripe.Invoice;
  let subscription: Stripe.Subscription;

  /** A bought monthly subscription, renewed once, read back from Stripe. */
  beforeEach(async () => {
    api = new FakeStripeApi();
    const stripe = api.client();
    const gateway = new StripeGateway(
      {
        secretKey: 'sk_test_fake',
        webhookSecret: FAKE_WEBHOOK_SECRET,
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
        productId: null,
        checkoutExpiresMinutes: 60,
      },
      stripe,
    );
    const customerId = await gateway.createCustomer('user-1', 'u@example.com');
    const session = await gateway.createCheckoutSession({
      checkoutId: 'checkout-1',
      authId: 'user-1',
      customerId,
      billingInterval: BillingInterval.MONTHLY,
      amountCents: 1900,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const completed = api.completeSession(session.id, { periodStart: anchor });
    const subscriptionId = completed.subscription as string;
    const renewal = api.renewSubscription(subscriptionId);
    invoice = await gateway.retrieveInvoice(renewal.id as string);
    subscription = await gateway.retrieveSubscription(subscriptionId);
    expected = {
      providerSubscriptionId: subscriptionId,
      providerCustomerId: customerId,
      billingInterval: BillingInterval.MONTHLY,
      amountCents: 1900,
      currency: 'USD',
    };
  });

  const changedInvoice = (mutate: (value: Stripe.Invoice) => void) => {
    const copy = structuredClone(invoice);
    mutate(copy);
    return copy;
  };
  const changedSubscription = (
    mutate: (value: Stripe.Subscription) => void,
  ) => {
    const copy = structuredClone(subscription);
    mutate(copy);
    return copy;
  };

  it('accepts a paid renewal with the period Stripe reports', () => {
    expect(verifyStripeRenewal(invoice, subscription, expected)).toEqual({
      outcome: 'PAID',
      payment: {
        providerPaymentId: invoice.id,
        providerSubscriptionId: subscription.id,
        amountCents: 1900,
        currency: 'USD',
        billingInterval: 'MONTHLY',
        periodStart: new Date('2026-02-28T10:00:00.000Z'),
        // Anchored on Jan 31: the second period ends Mar 31, not Mar 28.
        periodEnd: new Date('2026-03-31T10:00:00.000Z'),
        paidAt: expect.any(Date) as Date,
      },
    });
  });

  it.each<[string, (i: Stripe.Invoice) => void, string]>([
    [
      'the first invoice',
      (i) => (i.billing_reason = 'subscription_create'),
      'NOT_A_RENEWAL',
    ],
    ['a manual invoice', (i) => (i.billing_reason = 'manual'), 'NOT_A_RENEWAL'],
    [
      'an invoice of another subscription',
      (i) => {
        const details = i.parent?.subscription_details;
        if (details) details.subscription = 'sub_other';
      },
      'SUBSCRIPTION_MISMATCH',
    ],
    [
      "another customer's invoice",
      (i) => (i.customer = 'cus_other'),
      'CUSTOMER_MISMATCH',
    ],
    [
      'an open (unpaid) invoice',
      (i) => (i.status = 'open'),
      'INVOICE_NOT_PAID',
    ],
    ['a voided invoice', (i) => (i.status = 'void'), 'INVOICE_NOT_PAID'],
    ['another currency', (i) => (i.currency = 'eur'), 'CURRENCY_MISMATCH'],
    ['a partial payment', (i) => (i.amount_paid = 1000), 'AMOUNT_MISMATCH'],
    ['an overpayment', (i) => (i.amount_paid = 2900), 'AMOUNT_MISMATCH'],
    ['no invoice lines', (i) => (i.lines.data = []), 'INVALID_PERIOD'],
    [
      'a period that is not one billing month',
      (i) => {
        const period = i.lines.data[0].period;
        period.end = period.start + 10 * 86_400;
      },
      'INVALID_PERIOD',
    ],
  ])('rejects %s', (_label, mutate, reason) => {
    expect(
      verifyStripeRenewal(changedInvoice(mutate), subscription, expected),
    ).toEqual({ outcome: 'REJECTED', reason });
  });

  it.each<[string, (s: Stripe.Subscription) => void, string]>([
    [
      'another subscription object',
      (s) => (s.id = 'sub_other'),
      'SUBSCRIPTION_MISMATCH',
    ],
    [
      "another customer's subscription",
      (s) => (s.customer = 'cus_other'),
      'CUSTOMER_MISMATCH',
    ],
    [
      'a changed subscription price',
      (s) => (s.items.data[0].price.unit_amount = 100),
      'PRICE_MISMATCH',
    ],
    [
      'a changed interval',
      (s) => {
        const recurring = s.items.data[0].price.recurring;
        if (recurring) recurring.interval = 'year';
      },
      'PRICE_MISMATCH',
    ],
    [
      'an extra item',
      (s) => s.items.data.push(s.items.data[0]),
      'PRICE_MISMATCH',
    ],
  ])('rejects %s', (_label, mutate, reason) => {
    expect(
      verifyStripeRenewal(invoice, changedSubscription(mutate), expected),
    ).toEqual({ outcome: 'REJECTED', reason });
  });

  it('rejects a renewal expected at another price', () => {
    expect(
      verifyStripeRenewal(invoice, subscription, {
        ...expected,
        amountCents: 2900,
      }),
    ).toEqual({ outcome: 'REJECTED', reason: 'AMOUNT_MISMATCH' });
  });
});

describe('verifyStripeInvoice', () => {
  let api: FakeStripeApi;
  let gateway: StripeGateway;
  let expected: ExpectedInvoice;
  let subscriptionId: string;
  let sessionId: string;

  beforeEach(async () => {
    api = new FakeStripeApi();
    gateway = new StripeGateway(
      {
        secretKey: 'sk_test_fake',
        webhookSecret: FAKE_WEBHOOK_SECRET,
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
        productId: null,
        checkoutExpiresMinutes: 60,
      },
      api.client(),
    );
    const customerId = await gateway.createCustomer('user-1', 'u@example.com');
    const session = await gateway.createCheckoutSession({
      checkoutId: 'checkout-1',
      authId: 'user-1',
      customerId,
      billingInterval: BillingInterval.MONTHLY,
      amountCents: 1900,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    sessionId = session.id;
    api.failFirstPayment(session.id, {}, new Date('2026-01-31T10:00:00Z'));
    subscriptionId = api.sessions.get(session.id)?.subscription as string;
    expected = {
      providerSubscriptionId: subscriptionId,
      providerCustomerId: customerId,
      billingInterval: BillingInterval.MONTHLY,
      amountCents: 1900,
      currency: 'USD',
      checkoutId: 'checkout-1',
    };
  });

  const read = async (invoiceId: string) => ({
    invoice: await gateway.retrieveInvoice(invoiceId),
    subscription: await gateway.retrieveSubscription(subscriptionId),
  });
  const firstInvoiceId = () => api.sessions.get(sessionId)?.invoice as string;

  it('reports an open first invoice as UNPAID with its retry schedule', async () => {
    const { invoice, subscription } = await read(firstInvoiceId());
    expect(verifyStripeInvoice(invoice, subscription, expected)).toEqual({
      outcome: 'UNPAID',
      invoice: {
        providerInvoiceId: firstInvoiceId(),
        providerSubscriptionId: subscriptionId,
        kind: 'INITIAL',
        amountCents: 1900,
        currency: 'USD',
        billingInterval: 'MONTHLY',
        periodStart: new Date('2026-01-31T10:00:00.000Z'),
        periodEnd: new Date('2026-02-28T10:00:00.000Z'),
        paidAt: null,
        attemptCount: 1,
        nextRetryAt: expect.any(Date) as Date,
      },
    });
  });

  it('reports the same invoice as PAID once it is collected', async () => {
    api.completeSession(sessionId);
    const { invoice, subscription } = await read(firstInvoiceId());
    expect(verifyStripeInvoice(invoice, subscription, expected)).toMatchObject({
      outcome: 'PAID',
      invoice: { kind: 'INITIAL', paidAt: expect.any(Date) as Date },
    });
  });

  it('reports a failed renewal as an UNPAID RENEWAL and no retry after the last attempt', async () => {
    api.completeSession(sessionId);
    const renewal = api.renewSubscription(subscriptionId, {
      paid: false,
      failure: { final: true },
    });
    const { invoice, subscription } = await read(renewal.id as string);
    expect(verifyStripeInvoice(invoice, subscription, expected)).toMatchObject({
      outcome: 'UNPAID',
      invoice: {
        kind: 'RENEWAL',
        periodStart: new Date('2026-02-28T10:00:00.000Z'),
        periodEnd: new Date('2026-03-31T10:00:00.000Z'),
        nextRetryAt: null,
      },
    });
  });

  it('treats an uncollectible invoice as UNPAID', async () => {
    const { invoice, subscription } = await read(firstInvoiceId());
    invoice.status = 'uncollectible';
    expect(verifyStripeInvoice(invoice, subscription, expected).outcome).toBe(
      'UNPAID',
    );
  });

  it.each<
    [string, (invoice: Stripe.Invoice, s: Stripe.Subscription) => void, string]
  >([
    ['a void invoice', (i) => (i.status = 'void'), 'INVOICE_NOT_PAYABLE'],
    ['a draft invoice', (i) => (i.status = 'draft'), 'INVOICE_NOT_PAYABLE'],
    [
      'a manual invoice',
      (i) => (i.billing_reason = 'manual'),
      'NOT_A_SUBSCRIPTION_PAYMENT',
    ],
    ['another amount due', (i) => (i.amount_due = 100), 'AMOUNT_MISMATCH'],
    [
      'a subscription created by another checkout',
      (_i, s) => (s.metadata = { checkoutSessionId: 'checkout-2' }),
      'SUBSCRIPTION_MISMATCH',
    ],
    [
      "another customer's invoice",
      (i) => (i.customer = 'cus_other'),
      'CUSTOMER_MISMATCH',
    ],
  ])('rejects %s', async (_label, mutate, reason) => {
    const { invoice, subscription } = await read(firstInvoiceId());
    mutate(invoice, subscription);
    expect(verifyStripeInvoice(invoice, subscription, expected)).toEqual({
      outcome: 'REJECTED',
      reason,
    });
  });
});
