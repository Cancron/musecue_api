import { randomBytes } from 'node:crypto';
import { DiscountsModule } from '../src/discounts/discounts.module';
import {
  type CheckoutView,
  dataOf,
  discountCheckout,
  messageOf,
} from './support/discount-checkout';
import { FakeStripeApi } from './support/fake-stripe-api';
import { freezeTime } from './support/freeze-time';
import { describeWithDatabase } from './support/migrated-schema';
import {
  createStripeTestApp,
  type StripeTestApp,
} from './support/stripe-test-app';
import { daysFrom } from './support/subscription-fixtures';

jest.setTimeout(180_000);

const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

/**
 * Discount codes and promotional campaigns in the Stripe checkout: the best
 * available discount (highest percentage) is applied to the first Stripe
 * charge, rejected codes create nothing, and each redemption is reserved
 * with its checkout and redeemed once by its verified payment, whatever the
 * order, number or concurrency of requests and webhook deliveries.
 */
describeWithDatabase(
  'Discount codes and campaigns in the Stripe checkout (PostgreSQL)',
  () => {
    let harness: StripeTestApp;
    let d: ReturnType<typeof discountCheckout>;
    let admin: string;

    const code = (prefix = 'CODE') =>
      `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const createCode = (body: Record<string, unknown> = {}) =>
      d.createOffer(admin, 'codes', {
        code: code(),
        discountPercent: 30,
        startsAt: iso(-HOUR),
        endsAt: iso(30 * 24 * HOUR),
        ...body,
      });
    const createCampaign = (body: Record<string, unknown> = {}) =>
      d.createOffer(admin, 'campaigns', {
        name: `Holiday ${randomBytes(2).toString('hex')}`,
        discountPercent: 35,
        startsAt: iso(-HOUR),
        endsAt: iso(30 * 24 * HOUR),
        ...body,
      });
    const offerRow = (id: string) =>
      harness.client.discountOffer.findUniqueOrThrow({ where: { id } });
    const counters = async (id: string) => {
      const o = await offerRow(id);
      return {
        count: o.redemptionCount,
        reserved: o.reservedCount,
        spent: o.budgetSpentCents,
        reservedCents: o.budgetReservedCents,
      };
    };
    const checkoutsOf = (authId: string) =>
      harness.client.checkoutSession.count({
        where: { subscription: { authId } },
      });

    beforeAll(async () => {
      harness = await createStripeTestApp({ imports: [DiscountsModule] });
      d = discountCheckout(harness);
      admin = await d.admin();
    });

    beforeEach(async () => {
      harness.stripe.api = new FakeStripeApi(5);
      // Only offers in these tests; campaigns of earlier tests are switched off.
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

    describe('discount codes at checkout', () => {
      it('charges the code discount through Stripe and redeems it with the verified payment', async () => {
        const offer = await createCode({ discountPercent: 30 });
        const user = await d.user();

        const view = await d.open(user, 'MONTHLY', offer.code!.toLowerCase());

        expect(view).toMatchObject({
          amountCents: 1900,
          discount: {
            source: 'CODE',
            percent: 30,
            amountOffCents: 570,
            code: offer.code,
            offerId: offer.id,
          },
          amountDueCents: 1330,
        });
        await expect(counters(offer.id)).resolves.toEqual({
          count: 1,
          reserved: 1,
          spent: 0,
          reservedCents: 570,
        });

        const session = await d.pay(view.checkoutSessionId);
        expect(session.amount_total).toBe(1330);
        const row = await d.row(view.checkoutSessionId);
        const payment =
          await harness.client.paymentTransaction.findUniqueOrThrow({
            where: { id: row.paymentId! },
          });
        expect(payment.amountCents).toBe(1330);
        const invoice = harness.stripe.api.invoices.get(
          payment.providerInvoiceId!,
        )!;
        expect(invoice).toMatchObject({
          subtotal: 1900,
          amount_paid: 1330,
          total_discount_amounts: [{ amount: 570 }],
        });
        await expect(counters(offer.id)).resolves.toEqual({
          count: 1,
          reserved: 0,
          spent: 570,
          reservedCents: 0,
        });
        await expect(
          d.getOffer(admin, 'codes', offer.id),
        ).resolves.toMatchObject({
          redemptionCount: 1,
          reservedRedemptions: 0,
          redeemedRedemptions: 1,
          budgetSpentCents: 570,
        });
      });

      it.each([
        [
          'an unknown code',
          () => Promise.resolve('NO-SUCH-CODE'),
          404,
          'Discount code not found',
        ],
        [
          'a deactivated code',
          async () => {
            const o = await createCode();
            await d
              .http()
              .post(`/v1/admin/discount-codes/${o.id}/deactivate`)
              .set('Authorization', d.asAdmin(admin))
              .expect(200);
            return o.code!;
          },
          409,
          'This discount is not active',
        ],
        [
          'a 0% code',
          async () => (await createCode({ discountPercent: 0 })).code!,
          409,
          'This discount is not active',
        ],
        [
          'a code that has not started',
          async () =>
            (
              await createCode({
                startsAt: iso(24 * HOUR),
                endsAt: iso(48 * HOUR),
              })
            ).code!,
          409,
          'This discount has not started yet',
        ],
        [
          'an expired code',
          async () => {
            const o = await createCode({ endsAt: iso(2 * HOUR) });
            freezeTime(new Date(Date.now() + 3 * HOUR));
            return o.code!;
          },
          409,
          'This discount has expired',
        ],
        [
          'a code targeted at other users',
          async () =>
            (await createCode({ targetUserIds: [await d.user()] })).code!,
          403,
          'This discount is not available for your account',
        ],
        [
          'a code for the yearly option only',
          async () =>
            (await createCode({ eligibleProducts: ['PRO_YEARLY'] })).code!,
          409,
          'This discount does not apply to this purchase',
        ],
        [
          'a depleted code',
          async () => {
            const o = await createCode({ maxTotalRedemptions: 1 });
            await d.open(await d.user(), 'MONTHLY', o.code);
            return o.code!;
          },
          409,
          'This discount has no redemptions left',
        ],
      ])(
        'refuses %s and creates nothing, at Stripe or in PostgreSQL',
        async (_case, prepare, status, message) => {
          const entered = await prepare();
          const user = await d.user();
          const stripeRequests = harness.stripe.api.count(
            'POST',
            '/v1/checkout/sessions',
          );
          const couponRequests = harness.stripe.api.count(
            'POST',
            '/v1/coupons',
          );

          const response = await d
            .checkout(user, 'MONTHLY', entered)
            .expect(status);

          expect(messageOf(response)).toBe(message);
          await expect(checkoutsOf(user)).resolves.toBe(0);
          await expect(
            harness.client.discountRedemption.count({
              where: { authId: user },
            }),
          ).resolves.toBe(0);
          expect(
            harness.stripe.api.count('POST', '/v1/checkout/sessions'),
          ).toBe(stripeRequests);
          expect(harness.stripe.api.count('POST', '/v1/coupons')).toBe(
            couponRequests,
          );
        },
      );

      it('limits each user to maxRedemptionsPerUser across purchases', async () => {
        const offer = await createCode({
          maxRedemptionsPerUser: 1,
          endsAt: iso(120 * 24 * HOUR),
        });
        const user = await d.user();
        const view = await d.open(user, 'MONTHLY', offer.code);
        await d.pay(view.checkoutSessionId);
        const row = await d.row(view.checkoutSessionId);
        harness.stripe.api.cancelSubscription(row.providerSubscriptionId!);
        const payment =
          await harness.client.paymentTransaction.findUniqueOrThrow({
            where: { id: row.paymentId! },
          });
        freezeTime(daysFrom(payment.periodEnd, 1));

        const again = await d.checkout(user, 'MONTHLY', offer.code).expect(409);
        expect(messageOf(again)).toBe(
          'You have already redeemed this discount the maximum number of times',
        );
        // Without the code the user can buy at the full price.
        await expect(d.open(user)).resolves.toMatchObject({ discount: null });
      });
    });

    describe('the best available discount', () => {
      it('applies the highest percentage among first purchase, referral, an entered code and campaigns', async () => {
        await d.setDiscountSettings(admin, {
          firstPurchaseDiscountPercent: 20,
        });
        const campaign = await createCampaign({ discountPercent: 35 });
        const weakCode = await createCode({ discountPercent: 25 });
        const strongCode = await createCode({ discountPercent: 40 });

        const viaCampaign = await d.open(
          await d.user(),
          'MONTHLY',
          weakCode.code,
        );
        expect(viaCampaign.discount).toMatchObject({
          source: 'CAMPAIGN',
          percent: 35,
          offerId: campaign.id,
        });
        // The weaker code was not used up.
        await expect(counters(weakCode.id)).resolves.toMatchObject({
          count: 0,
        });

        const viaCode = await d.open(
          await d.user(),
          'MONTHLY',
          strongCode.code,
        );
        expect(viaCode.discount).toMatchObject({
          source: 'CODE',
          percent: 40,
          amountOffCents: 760,
        });

        await harness.client.discountOffer.update({
          where: { id: campaign.id },
          data: { active: false },
        });
        const viaFirst = await d.open(await d.user(), 'MONTHLY', undefined);
        expect(viaFirst.discount).toMatchObject({
          source: 'FIRST_PURCHASE',
          percent: 20,
        });
      });

      it('applies running campaigns automatically, only to the products they target', async () => {
        const yearlyOnly = await createCampaign({
          discountPercent: 50,
          eligibleProducts: ['PRO_YEARLY'],
        });
        const user = await d.user();
        await expect(d.open(user, 'MONTHLY')).resolves.toMatchObject({
          discount: null,
        });
        const other = await d.user();
        await expect(d.open(other, 'YEARLY')).resolves.toMatchObject({
          discount: {
            source: 'CAMPAIGN',
            offerId: yearlyOnly.id,
            amountOffCents: 9500,
          },
          amountDueCents: 9500,
        });
      });

      it('charges exactly $0 for a 100% discount, never Stripe’s $0.50 minimum', async () => {
        const free = await createCode({ discountPercent: 100 });
        const user = await d.user();
        const view = await d.open(user, 'MONTHLY', free.code);
        expect(view).toMatchObject({
          discount: { percent: 100, amountOffCents: 1900 },
          amountDueCents: 0,
        });
        const session = await d.pay(view.checkoutSessionId);
        expect(session).toMatchObject({
          amount_total: 0,
          payment_status: 'no_payment_required',
        });
        await expect(harness.status(user)).resolves.toMatchObject({
          status: 'PRO',
        });
        const row = await d.row(view.checkoutSessionId);
        await expect(
          harness.client.paymentTransaction.findUniqueOrThrow({
            where: { id: row.paymentId! },
          }),
        ).resolves.toMatchObject({ status: 'SUCCEEDED', amountCents: 0 });
        // The renewal is charged the plan price.
        const renewal = harness.stripe.api.renewSubscription(
          row.providerSubscriptionId!,
        );
        expect(renewal.amount_paid).toBe(1900);
      });

      it('waives a discounted charge below $0.50 instead of rounding it up', async () => {
        const almost = await createCode({ discountPercent: 99 });
        const view = await d.open(await d.user(), 'MONTHLY', almost.code);
        // 1% of $19.00 is $0.19, which Stripe cannot charge: it is free.
        expect(view).toMatchObject({
          discount: { percent: 99, amountOffCents: 1900 },
          amountDueCents: 0,
        });
      });
    });

    describe('pending checkouts', () => {
      it('reuses the pending checkout for the same code and replaces it, releasing the reservation, for another one', async () => {
        const first = await createCode({ discountPercent: 30 });
        const second = await createCode({ discountPercent: 10 });
        const user = await d.user();

        const opened = await d.open(user, 'MONTHLY', first.code);
        const reused = await d.open(user, 'MONTHLY', first.code!.toLowerCase());
        expect(reused).toMatchObject({
          checkoutSessionId: opened.checkoutSessionId,
          reused: true,
        });
        await expect(counters(first.id)).resolves.toMatchObject({
          count: 1,
          reserved: 1,
        });

        const replaced = await d.open(user, 'MONTHLY', second.code);
        expect(replaced.checkoutSessionId).not.toBe(opened.checkoutSessionId);
        expect(replaced.discount).toMatchObject({
          source: 'CODE',
          offerId: second.id,
          percent: 10,
        });
        // Stripe confirmed the old session expired before anything was released.
        expect(
          harness.stripe.api.sessions.get(
            await d.sessionId(opened.checkoutSessionId),
          )?.status,
        ).toBe('expired');
        await expect(
          d.redemption(opened.checkoutSessionId),
        ).resolves.toMatchObject({
          status: 'RELEASED',
          releaseReason: 'REPLACED',
        });
        await expect(counters(first.id)).resolves.toEqual({
          count: 0,
          reserved: 0,
          spent: 0,
          reservedCents: 0,
        });
        await expect(counters(second.id)).resolves.toMatchObject({
          count: 1,
          reserved: 1,
        });
        expect(harness.stripe.api.openSessions()).toHaveLength(1);
      });

      it('keeps the discount of a pending checkout when the offer changes afterwards', async () => {
        const offer = await createCode({ discountPercent: 30 });
        const user = await d.user();
        const opened = await d.open(user, 'MONTHLY', offer.code);
        await d
          .patchOffer(admin, 'codes', offer.id, { discountPercent: 5 })
          .expect(200);

        const reused = await d.open(user, 'MONTHLY', offer.code);
        expect(reused).toMatchObject({ reused: true, amountDueCents: 1330 });
        await d.pay(opened.checkoutSessionId);
        await expect(
          d.redemption(opened.checkoutSessionId),
        ).resolves.toMatchObject({ status: 'REDEEMED', discountPercent: 30 });
      });
    });

    describe('used once and charged exactly', () => {
      it('never exceeds a code’s total limit under concurrent checkouts of many users', async () => {
        const offer = await createCode({ maxTotalRedemptions: 3 });
        const users = await Promise.all(
          Array.from({ length: 10 }, () => d.user()),
        );

        const responses = await Promise.all(
          users.map((user) => d.checkout(user, 'MONTHLY', offer.code)),
        );

        expect(responses.filter((r) => r.status === 201)).toHaveLength(3);
        for (const refused of responses.filter((r) => r.status !== 201)) {
          expect(refused.status).toBe(409);
          expect(messageOf(refused)).toBe(
            'This discount has no redemptions left',
          );
        }
        await expect(counters(offer.id)).resolves.toMatchObject({
          count: 3,
          reserved: 3,
        });
        await expect(
          harness.client.discountRedemption.count({
            where: { offerId: offer.id, status: 'RESERVED' },
          }),
        ).resolves.toBe(3);
      });

      it('redeems once for unordered, repeated and concurrent payment events', async () => {
        const offer = await createCode();
        const user = await d.user();
        const view = await d.open(user, 'MONTHLY', offer.code);
        const sessionId = await d.sessionId(view.checkoutSessionId);
        const api = harness.stripe.api;
        api.completeSession(sessionId);
        const invoiceId = api.sessions.get(sessionId)?.invoice as string;

        await Promise.all([
          d.sendInvoiceEvent('invoice.paid', invoiceId),
          d.sendSessionEvent('checkout.session.completed', sessionId),
          d.sendInvoiceEvent('invoice.paid', invoiceId),
          d.sendSessionEvent('checkout.session.completed', sessionId),
        ]);
        await d.sendInvoiceEvent('invoice.paid', invoiceId).expect(200);

        await expect(
          harness.client.paymentTransaction.count({
            where: { subscription: { authId: user } },
          }),
        ).resolves.toBe(1);
        await expect(counters(offer.id)).resolves.toEqual({
          count: 1,
          reserved: 0,
          spent: 570,
          reservedCents: 0,
        });
      });

      it('refuses to grant Pro when the Stripe charge does not reflect the discount', async () => {
        const offer = await createCode();
        const user = await d.user();
        const view: CheckoutView = await d.open(user, 'MONTHLY', offer.code);

        // Stripe collected the full price instead of the discounted amount.
        await d.pay(view.checkoutSessionId, { invoiceAmount: 1900 });

        await expect(harness.status(user)).resolves.toMatchObject({
          status: 'FREE',
        });
        await expect(
          harness.client.paymentTransaction.count({
            where: { subscription: { authId: user } },
          }),
        ).resolves.toBe(0);
        await expect(
          d.redemption(view.checkoutSessionId),
        ).resolves.toMatchObject({ status: 'RESERVED' });
      });

      it('has PostgreSQL refuse to change the discount of a checkout or the redemption terms', async () => {
        const offer = await createCode();
        const view = await d.open(await d.user(), 'MONTHLY', offer.code);
        await expect(
          harness.client.checkoutSession.update({
            where: { id: view.checkoutSessionId },
            data: { discountCents: 1 },
          }),
        ).rejects.toThrow('discount of a checkout cannot change');
        await expect(
          harness.client.discountRedemption.update({
            where: { checkoutSessionId: view.checkoutSessionId },
            data: { discountUsdCents: 1, finalPriceUsdCents: 1899 },
          }),
        ).rejects.toThrow('cannot be changed');
        await expect(
          harness.client.discountOffer.update({
            where: { id: offer.id },
            data: { reservedCount: 0 },
          }),
        ).rejects.toThrow('cannot decrease or change outside its redemptions');
      });
    });

    it('GET /v1/discount-campaigns lists the campaigns a user can use', async () => {
      const campaign = await createCampaign({
        discountPercent: 15,
        eligibleProducts: ['PRO_YEARLY'],
        minSpendCents: 1000,
      });
      const user = await d.user();
      const list = dataOf<Array<Record<string, unknown>>>(
        await d
          .http()
          .get('/v1/discount-campaigns')
          .set('Authorization', harness.bearer(user))
          .expect(200),
      );
      expect(list.find((c) => c.id === campaign.id)).toMatchObject({
        discountPercent: 15,
        eligibleProducts: ['PRO_YEARLY'],
        minSpendCents: 1000,
        remainingRedemptionsForYou: 1,
      });
    });
  },
);
