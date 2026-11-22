import { randomBytes } from 'node:crypto';
import { DiscountsModule } from '../src/discounts/discounts.module';
import {
  type CheckoutView,
  dataOf,
  discountCheckout,
  messageOf,
  type OfferView,
} from './support/discount-checkout';
import { FakeStripeApi } from './support/fake-stripe-api';
import { describeWithDatabase } from './support/migrated-schema';
import {
  createStripeTestApp,
  type StripeTestApp,
} from './support/stripe-test-app';
import { daysFrom, givenPaidProHistory } from './support/subscription-fixtures';

jest.setTimeout(180_000);

const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

/**
 * Campaign budget controls in the Stripe checkout: minimum spend, customer
 * and product targeting, a USD budget whose usage is reserved with each
 * checkout and spent by its payment. Concurrent checkouts never exceed the
 * budget or the redemption limit; a reservation is given back only when its
 * checkout can no longer be paid; late payments never overspend or redeem
 * twice.
 */
describeWithDatabase(
  'Campaign budgets in the Stripe checkout (PostgreSQL)',
  () => {
    let harness: StripeTestApp;
    let d: ReturnType<typeof discountCheckout>;
    let admin: string;

    const createCampaign = (body: Record<string, unknown> = {}) =>
      d.createOffer(admin, 'campaigns', {
        name: `Budget ${randomBytes(2).toString('hex')}`,
        discountPercent: 20,
        startsAt: iso(-HOUR),
        endsAt: iso(30 * 24 * HOUR),
        ...body,
      });
    const view = (id: string) => d.getOffer(admin, 'campaigns', id);
    const budget = async (id: string) => {
      const offer = await view(id);
      return {
        spent: offer.budgetSpentCents,
        reserved: offer.budgetReservedCents,
        remaining: offer.budgetRemainingCents,
        redemptions: offer.redemptionCount,
      };
    };
    /** Invariants that must hold whatever happened. */
    const expectWithinLimits = async (id: string) => {
      const offer = await harness.client.discountOffer.findUniqueOrThrow({
        where: { id },
      });
      const rows = await harness.client.discountRedemption.findMany({
        where: { offerId: id },
      });
      const active = rows.filter((r) => r.status !== 'RELEASED');
      expect(offer.redemptionCount).toBe(active.length);
      expect(offer.reservedCount).toBe(
        rows.filter((r) => r.status === 'RESERVED').length,
      );
      expect(offer.budgetSpentCents).toBe(
        rows
          .filter((r) => r.status === 'REDEEMED')
          .reduce((sum, r) => sum + r.discountUsdCents, 0),
      );
      expect(offer.budgetReservedCents).toBe(
        rows
          .filter((r) => r.status === 'RESERVED')
          .reduce((sum, r) => sum + r.discountUsdCents, 0),
      );
      if (offer.budgetCents !== null) {
        expect(
          offer.budgetSpentCents + offer.budgetReservedCents,
        ).toBeLessThanOrEqual(offer.budgetCents);
      }
      if (offer.maxTotalRedemptions !== null) {
        expect(offer.redemptionCount).toBeLessThanOrEqual(
          offer.maxTotalRedemptions,
        );
      }
    };

    beforeAll(async () => {
      harness = await createStripeTestApp({ imports: [DiscountsModule] });
      d = discountCheckout(harness);
      admin = await d.admin();
    });

    beforeEach(async () => {
      harness.stripe.api = new FakeStripeApi(5);
      await d.setDiscountSettings(admin, {
        firstPurchaseDiscountPercent: 0,
        referralDiscountPercent: 0,
      });
      await harness.client.discountOffer.updateMany({
        where: { kind: 'CAMPAIGN' },
        data: { active: false },
      });
    });

    afterEach(() => jest.useRealTimers());

    afterAll(async () => {
      jest.useRealTimers();
      await harness?.close();
    });

    describe('administration', () => {
      it('stores the budget controls and reports budget usage', async () => {
        const campaign = await createCampaign({
          budgetCents: 1000,
          minSpendCents: 1500,
          customerEligibility: 'NEW_CUSTOMERS',
          eligibleProducts: ['PRO_YEARLY', 'PRO_MONTHLY'],
        });
        expect(campaign).toMatchObject({
          budgetCents: 1000,
          budgetSpentCents: 0,
          budgetReservedCents: 0,
          budgetRemainingCents: 1000,
          minSpendCents: 1500,
          customerEligibility: 'NEW_CUSTOMERS',
          eligibleProducts: ['PRO_MONTHLY', 'PRO_YEARLY'],
        });
        await d
          .patchOffer(admin, 'campaigns', campaign.id, {
            eligibleProducts: null,
            budgetCents: null,
          })
          .expect(200);
        await expect(view(campaign.id)).resolves.toMatchObject({
          eligibleProducts: [],
          budgetCents: null,
          budgetRemainingCents: null,
        });
      });

      it.each([
        ['a zero budget', { budgetCents: 0 }],
        ['a negative budget', { budgetCents: -100 }],
        ['a fractional budget', { budgetCents: 10.5 }],
        ['a budget in dollars as a string', { budgetCents: '10.00' }],
        ['a negative minimum spend', { minSpendCents: -1 }],
        ['an unknown product', { eligibleProducts: ['PRO_LIFETIME'] }],
        ['an empty product list', { eligibleProducts: [] }],
        [
          'duplicate products',
          { eligibleProducts: ['PRO_YEARLY', 'PRO_YEARLY'] },
        ],
        ['an unknown customer group', { customerEligibility: 'VIP' }],
        ['a budget usage field', { budgetSpentCents: 0 }],
      ])('rejects %s with 400 and stores nothing', async (_case, body) => {
        const before = await harness.client.discountOffer.count();
        await d
          .http()
          .post('/v1/admin/discount-campaigns')
          .set('Authorization', d.asAdmin(admin))
          .send({
            name: 'Invalid',
            discountPercent: 10,
            startsAt: iso(-HOUR),
            endsAt: iso(HOUR * 48),
            ...body,
          })
          .expect(400);
        await expect(harness.client.discountOffer.count()).resolves.toBe(
          before,
        );
      });

      it('never lowers a budget below what is already spent or reserved', async () => {
        const campaign = await createCampaign({ budgetCents: 2000 });
        await d.open(await d.user());
        await d.open(await d.user());
        await expect(budget(campaign.id)).resolves.toMatchObject({
          reserved: 760,
        });

        const refused = await d
          .patchOffer(admin, 'campaigns', campaign.id, { budgetCents: 759 })
          .expect(409);
        expect(messageOf(refused)).toBe(
          'budgetCents cannot be lower than the 760 cents already spent or reserved',
        );
        await d
          .patchOffer(admin, 'campaigns', campaign.id, { budgetCents: 760 })
          .expect(200);
        await expect(view(campaign.id)).resolves.toMatchObject({
          status: 'DEPLETED',
          budgetRemainingCents: 0,
        });
        await expectWithinLimits(campaign.id);
      });
    });

    describe('targeting', () => {
      it('applies only from the minimum spend', async () => {
        const campaign = await createCampaign({
          discountPercent: 20,
          minSpendCents: 5000,
        });
        await expect(d.open(await d.user(), 'MONTHLY')).resolves.toMatchObject({
          discount: null,
        });
        await expect(d.open(await d.user(), 'YEARLY')).resolves.toMatchObject({
          discount: {
            source: 'CAMPAIGN',
            offerId: campaign.id,
            amountOffCents: 3800,
          },
          amountDueCents: 15200,
        });
      });

      it('applies only to the products it targets', async () => {
        const campaign = await createCampaign({
          eligibleProducts: ['PRO_MONTHLY'],
        });
        await expect(d.open(await d.user(), 'YEARLY')).resolves.toMatchObject({
          discount: null,
        });
        await expect(d.open(await d.user(), 'MONTHLY')).resolves.toMatchObject({
          discount: { offerId: campaign.id },
        });
      });

      it('separates new and returning customers, and targeted users', async () => {
        const forNew = await createCampaign({
          discountPercent: 20,
          customerEligibility: 'NEW_CUSTOMERS',
        });
        const forReturning = await createCampaign({
          discountPercent: 25,
          customerEligibility: 'RETURNING_CUSTOMERS',
        });
        const newcomer = await d.user();
        const returning = await d.user();
        await givenPaidProHistory(
          harness.client,
          returning,
          { billingInterval: 'MONTHLY', startedAt: daysFrom(new Date(), -90) },
          new Date(),
        );

        await expect(d.open(newcomer)).resolves.toMatchObject({
          discount: { offerId: forNew.id, percent: 20 },
        });
        await expect(d.open(returning)).resolves.toMatchObject({
          discount: { offerId: forReturning.id, percent: 25 },
        });

        const vip = await d.user();
        const targeted = await createCampaign({
          discountPercent: 60,
          targetUserIds: [vip],
        });
        await expect(d.open(vip)).resolves.toMatchObject({
          discount: { offerId: targeted.id, percent: 60 },
        });
        await expect(d.open(await d.user())).resolves.toMatchObject({
          discount: { offerId: forNew.id },
        });
      });
    });

    describe('budget reservation and usage', () => {
      it('reserves the budget with each checkout, spends it with the payment and skips a campaign without enough budget left', async () => {
        const campaign = await createCampaign({
          discountPercent: 20,
          budgetCents: 1000,
        });
        const first = await d.open(await d.user());
        const second = await d.open(await d.user());
        expect([
          first.discount?.amountOffCents,
          second.discount?.amountOffCents,
        ]).toEqual([380, 380]);
        await expect(budget(campaign.id)).resolves.toEqual({
          spent: 0,
          reserved: 760,
          remaining: 240,
          redemptions: 2,
        });

        // 240 cents left: the next checkout gets no campaign discount.
        await expect(d.open(await d.user())).resolves.toMatchObject({
          discount: null,
          amountDueCents: 1900,
        });

        await d.pay(first.checkoutSessionId);
        await expect(budget(campaign.id)).resolves.toEqual({
          spent: 380,
          reserved: 380,
          remaining: 240,
          redemptions: 2,
        });
        await expectWithinLimits(campaign.id);
      });

      it('refuses an entered code without enough budget left', async () => {
        const offer = await d.createOffer(admin, 'codes', {
          code: `BUDGET-${randomBytes(3).toString('hex').toUpperCase()}`,
          discountPercent: 20,
          startsAt: iso(-HOUR),
          endsAt: iso(30 * 24 * HOUR),
          budgetCents: 500,
        });
        await d.open(await d.user(), 'MONTHLY', offer.code);
        const refused = await d
          .checkout(await d.user(), 'MONTHLY', offer.code)
          .expect(409);
        expect(messageOf(refused)).toBe('This discount has no budget left');
      });

      it('never exceeds the budget under concurrent checkouts', async () => {
        // 20% of $19.00 = 380 cents: a budget of 2000 covers 5 checkouts.
        const campaign = await createCampaign({
          discountPercent: 20,
          budgetCents: 2000,
        });
        const users = await Promise.all(
          Array.from({ length: 14 }, () => d.user()),
        );

        const views = (
          await Promise.all(users.map((user) => d.checkout(user)))
        ).map((r) => {
          expect(r.status).toBe(201);
          return dataOf<CheckoutView>(r);
        });

        expect(
          views.filter((v) => v.discount?.offerId === campaign.id),
        ).toHaveLength(5);
        expect(views.filter((v) => v.discount === null)).toHaveLength(9);
        await expect(budget(campaign.id)).resolves.toEqual({
          spent: 0,
          reserved: 1900,
          remaining: 100,
          redemptions: 5,
        });
        await expectWithinLimits(campaign.id);
      });

      it('never exceeds the redemption limit under concurrent checkouts', async () => {
        const campaign = await createCampaign({
          discountPercent: 20,
          maxTotalRedemptions: 3,
          budgetCents: 100_000,
        });
        const users = await Promise.all(
          Array.from({ length: 12 }, () => d.user()),
        );

        const views = await Promise.all(
          users.map(async (user) =>
            dataOf<CheckoutView>(await d.checkout(user).expect(201)),
          ),
        );

        expect(
          views.filter((v) => v.discount?.offerId === campaign.id),
        ).toHaveLength(3);
        const offer: OfferView = await view(campaign.id);
        expect(offer).toMatchObject({
          redemptionCount: 3,
          reservedRedemptions: 3,
          remainingRedemptions: 0,
          status: 'DEPLETED',
        });
        await expectWithinLimits(campaign.id);
      });
    });

    describe('release and late payments', () => {
      it('gives the budget back when an unpaid checkout expires, and only then', async () => {
        const campaign = await createCampaign({
          discountPercent: 20,
          budgetCents: 380,
        });
        const abandoned = await d.open(await d.user());
        await expect(d.open(await d.user())).resolves.toMatchObject({
          discount: null,
        });

        await d.abandon(abandoned.checkoutSessionId);
        await expect(budget(campaign.id)).resolves.toEqual({
          spent: 0,
          reserved: 0,
          remaining: 380,
          redemptions: 0,
        });
        // A redelivered expiry changes nothing.
        await d
          .sendSessionEvent(
            'checkout.session.expired',
            await d.sessionId(abandoned.checkoutSessionId),
          )
          .expect(200);

        const next = await d.open(await d.user());
        expect(next.discount).toMatchObject({ offerId: campaign.id });
        await expectWithinLimits(campaign.id);
      });

      it('holds the budget of a failed delayed payment and spends it when the payment succeeds late', async () => {
        const campaign = await createCampaign({
          discountPercent: 20,
          budgetCents: 380,
        });
        const user = await d.user();
        const checkout = await d.open(user);
        const sessionId = await d.sessionId(checkout.checkoutSessionId);
        const api = harness.stripe.api;

        // A delayed payment method: completed but unpaid, then it fails.
        api.completeSession(sessionId, { paymentStatus: 'unpaid' });
        await d
          .sendSessionEvent('checkout.session.completed', sessionId)
          .expect(200);
        await d
          .sendSessionEvent('checkout.session.async_payment_failed', sessionId)
          .expect(200);
        await expect(d.row(checkout.checkoutSessionId)).resolves.toMatchObject({
          status: 'FAILED',
        });
        // The subscription's first invoice can still be paid: still reserved.
        await expect(budget(campaign.id)).resolves.toEqual({
          spent: 0,
          reserved: 380,
          remaining: 0,
          redemptions: 1,
        });
        await expect(d.open(await d.user())).resolves.toMatchObject({
          discount: null,
        });

        // It is paid after all: the reservation is spent, once.
        api.settleDelayedPayment(sessionId);
        const invoiceId = api.sessions.get(sessionId)?.invoice as string;
        await d.sendInvoiceEvent('invoice.paid', invoiceId).expect(200);
        await d.sendInvoiceEvent('invoice.paid', invoiceId).expect(200);

        await expect(harness.status(user)).resolves.toMatchObject({
          status: 'PRO',
        });
        await expect(
          d.redemption(checkout.checkoutSessionId),
        ).resolves.toMatchObject({ status: 'REDEEMED' });
        await expect(budget(campaign.id)).resolves.toEqual({
          spent: 380,
          reserved: 0,
          remaining: 0,
          redemptions: 1,
        });
        await expectWithinLimits(campaign.id);
      });

      /** A declined first payment whose subscription Stripe later ended unpaid: released. */
      const releasedAfterDecline = async (campaignId: string) => {
        const user = await d.user();
        const checkout = await d.open(user);
        expect(checkout.discount).toMatchObject({ offerId: campaignId });
        const sessionId = await d.sessionId(checkout.checkoutSessionId);
        const api = harness.stripe.api;
        const invoice = api.failFirstPayment(sessionId);
        api.expireByTime(sessionId);
        await d
          .sendSessionEvent('checkout.session.expired', sessionId)
          .expect(200);
        // Still payable (incomplete subscription): held.
        await expect(
          d.redemption(checkout.checkoutSessionId),
        ).resolves.toMatchObject({ status: 'RESERVED' });
        const subscriptionId = api.sessions.get(sessionId)
          ?.subscription as string;
        api.expireIncompleteSubscription(subscriptionId);
        await d
          .sendSubscriptionEvent(
            'customer.subscription.deleted',
            subscriptionId,
          )
          .expect(200);
        await expect(
          d.redemption(checkout.checkoutSessionId),
        ).resolves.toMatchObject({ status: 'RELEASED' });
        return { user, checkout, invoiceId: invoice.id as string };
      };

      it('counts a late payment after the release again when the budget still allows it', async () => {
        const campaign = await createCampaign({
          discountPercent: 20,
          budgetCents: 760,
        });
        const late = await releasedAfterDecline(campaign.id);
        await expect(budget(campaign.id)).resolves.toMatchObject({
          spent: 0,
          reserved: 0,
        });

        // Paid outside the normal flow after all (e.g. in the Stripe dashboard).
        harness.stripe.api.payInvoice(late.invoiceId);
        await d.sendInvoiceEvent('invoice.paid', late.invoiceId).expect(200);

        await expect(
          d.redemption(late.checkout.checkoutSessionId),
        ).resolves.toMatchObject({ status: 'REDEEMED' });
        await expect(budget(campaign.id)).resolves.toEqual({
          spent: 380,
          reserved: 0,
          remaining: 380,
          redemptions: 1,
        });
        await expectWithinLimits(campaign.id);
      });

      it('never overspends for a late payment once the released budget was used by others', async () => {
        const campaign = await createCampaign({
          discountPercent: 20,
          budgetCents: 380,
        });
        const late = await releasedAfterDecline(campaign.id);
        // The released budget goes to another customer, who pays.
        const other = await d.open(await d.user());
        expect(other.discount).toMatchObject({ offerId: campaign.id });
        await d.pay(other.checkoutSessionId);

        harness.stripe.api.payInvoice(late.invoiceId);
        await d.sendInvoiceEvent('invoice.paid', late.invoiceId).expect(200);
        await d.sendInvoiceEvent('invoice.paid', late.invoiceId).expect(200);

        // The customer who paid late keeps their purchase; the discount is not
        // counted a second time and the budget is not exceeded.
        await expect(harness.status(late.user)).resolves.toMatchObject({
          status: 'PRO',
        });
        await expect(
          d.redemption(late.checkout.checkoutSessionId),
        ).resolves.toMatchObject({
          status: 'RELEASED',
          paymentId: expect.any(String) as unknown,
        });
        await expect(budget(campaign.id)).resolves.toEqual({
          spent: 380,
          reserved: 0,
          remaining: 0,
          redemptions: 1,
        });
        await expectWithinLimits(campaign.id);
      });

      it('has PostgreSQL refuse redemptions beyond the budget from any write path', async () => {
        const campaign = await createCampaign({
          discountPercent: 20,
          budgetCents: 500,
        });
        await d.open(await d.user());
        const user = await d.user();
        await expect(
          harness.client.discountRedemption.create({
            data: {
              offerId: campaign.id,
              authId: user,
              source: 'CAMPAIGN',
              status: 'RESERVED',
              idempotencyKey: 'manual',
              product: 'PRO_MONTHLY',
              discountPercent: 20,
              originalPriceUsdCents: 1900,
              discountUsdCents: 380,
              finalPriceUsdCents: 1520,
              reservedAt: new Date(),
            },
          }),
        ).rejects.toThrow('no budget left');
        await expect(
          harness.client.discountOffer.update({
            where: { id: campaign.id },
            data: { budgetReservedCents: 0 },
          }),
        ).rejects.toThrow('cannot decrease or change outside its redemptions');
        await expectWithinLimits(campaign.id);
      });
    });
  },
);
