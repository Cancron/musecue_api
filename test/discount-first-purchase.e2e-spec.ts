import { randomBytes } from 'node:crypto';
import { DiscountsModule } from '../src/discounts/discounts.module';
import { ReferralRegistrationService } from '../src/referrals/referral-registration.service';
import { ReferralsModule } from '../src/referrals/referrals.module';
import {
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

interface ReferralView {
  code: string;
  referred: boolean;
  referralDiscountPercent: number;
}

/**
 * The first-purchase and referral discounts in the Stripe checkout, through
 * the real HTTP stack (SubscriptionModule + DiscountsModule) on a migrated
 * PostgreSQL schema, with FakeStripeApi behind the real Stripe SDK and
 * signed webhooks. Both discounts stay available until the user's first
 * successful paid purchase, whatever happens before it (trial, failed,
 * canceled or abandoned checkouts), and each is used at most once.
 */
describeWithDatabase(
  'First-purchase and referral discounts (PostgreSQL, Stripe checkout)',
  () => {
    let harness: StripeTestApp;
    let d: ReturnType<typeof discountCheckout>;
    let admin: string;

    const redemptionsOf = (authId: string) =>
      harness.client.discountRedemption.findMany({
        where: { authId },
        orderBy: { createdAt: 'asc' },
      });
    const paymentsOf = async (authId: string) =>
      harness.client.paymentTransaction.findMany({
        where: { subscription: { authId } },
        orderBy: { createdAt: 'asc' },
      });
    const referralOf = async (userId: string) =>
      dataOf<ReferralView>(
        await d
          .http()
          .get('/v1/referrals')
          .set('Authorization', harness.bearer(userId))
          .expect(200),
      );
    const applyReferral = (userId: string, code: string) =>
      d
        .http()
        .post('/v1/referrals/apply')
        .set('Authorization', harness.bearer(userId))
        .send({ code });
    /**
     * A user who signed up with the referrer's code: the account and its
     * referral are created in one transaction, as registration does.
     */
    const signUpReferred = async (referrerId: string) => {
      const { code } = await referralOf(referrerId);
      const tag = randomBytes(6).toString('hex');
      const email = `${tag}@example.com`;
      return harness.client.$transaction(async (tx) => {
        const user = await tx.authUser.create({
          data: {
            email,
            username: `user_${tag}`,
            password: 'not-a-real-hash',
            verified: true,
          },
        });
        await harness.app
          .get(ReferralRegistrationService)
          .registerAtSignup(tx, { authId: user.id, email, code });
        return user.id;
      });
    };
    /** Pays the checkout and moves past the paid term with the Stripe subscription ended. */
    const payAndLetExpire = async (checkoutId: string) => {
      await d.pay(checkoutId);
      const row = await d.row(checkoutId);
      harness.stripe.api.cancelSubscription(
        row.providerSubscriptionId as string,
      );
      const payment = await harness.client.paymentTransaction.findUniqueOrThrow(
        {
          where: { id: row.paymentId as string },
        },
      );
      freezeTime(daysFrom(payment.periodEnd, 1));
    };

    beforeAll(async () => {
      harness = await createStripeTestApp({
        imports: [DiscountsModule, ReferralsModule],
      });
      d = discountCheckout(harness);
      admin = await d.admin();
    });

    beforeEach(async () => {
      harness.stripe.api = new FakeStripeApi(5);
      await d.setDiscountSettings(admin, {
        firstPurchaseDiscountPercent: 20,
        referralDiscountPercent: 0,
        referrerRewardCredits: 0,
      });
    });

    afterEach(() => jest.useRealTimers());

    afterAll(async () => {
      jest.useRealTimers();
      await harness?.close();
    });

    describe('first-purchase discount', () => {
      it('discounts the first Stripe charge only, without changing the plan price', async () => {
        const user = await d.user();

        const view = await d.open(user);

        expect(view).toMatchObject({
          billingInterval: 'MONTHLY',
          amountCents: 1900,
          discount: {
            source: 'FIRST_PURCHASE',
            percent: 20,
            amountOffCents: 380,
          },
          amountDueCents: 1520,
          reused: false,
        });
        // Stripe: the plan price on the line item, a one-time coupon for the
        // discount, and a session total of the discounted amount.
        const api = harness.stripe.api;
        const session = api.sessions.get(
          await d.sessionId(view.checkoutSessionId),
        ) as Record<string, unknown>;
        expect(
          (
            session.line_items as Array<{ price_data: { unit_amount: string } }>
          )[0].price_data.unit_amount,
        ).toBe('1900');
        expect(session.amount_total).toBe(1520);
        expect([...api.coupons.values()]).toEqual([
          expect.objectContaining({
            id: `musecue-${view.checkoutSessionId}`,
            amount_off: 380,
            currency: 'usd',
            duration: 'once',
            max_redemptions: 1,
          }),
        ]);
        await expect(
          d.redemption(view.checkoutSessionId),
        ).resolves.toMatchObject({
          source: 'FIRST_PURCHASE',
          status: 'RESERVED',
          originalPriceUsdCents: 1900,
          discountUsdCents: 380,
          finalPriceUsdCents: 1520,
        });

        await d.pay(view.checkoutSessionId);

        await expect(harness.status(user)).resolves.toMatchObject({
          status: 'PRO',
        });
        const [payment] = await paymentsOf(user);
        expect(payment).toMatchObject({
          status: 'SUCCEEDED',
          amountCents: 1520,
        });
        await expect(
          d.redemption(view.checkoutSessionId),
        ).resolves.toMatchObject({
          status: 'REDEEMED',
          paymentId: payment.id,
        });
        // The plan configuration is untouched.
        await expect(
          d
            .http()
            .get('/v1/admin/subscription-plan')
            .set('Authorization', d.asAdmin(admin))
            .then(dataOf),
        ).resolves.toMatchObject({
          monthlyPriceUsdCents: 1900,
          yearlyPriceUsdCents: 19000,
        });

        // The renewal is charged the full plan price.
        const row = await d.row(view.checkoutSessionId);
        const renewal = api.renewSubscription(
          row.providerSubscriptionId as string,
        );
        expect(renewal.amount_paid).toBe(1900);
        await d
          .sendInvoiceEvent('invoice.paid', renewal.id as string)
          .expect(200);
        expect((await paymentsOf(user)).map((p) => p.amountCents)).toEqual([
          1520, 1900,
        ]);
        await expect(redemptionsOf(user)).resolves.toHaveLength(1);
      });

      it('applies to the yearly option too', async () => {
        const user = await d.user();
        const view = await d.open(user, 'YEARLY');
        expect(view).toMatchObject({
          amountCents: 19000,
          discount: { source: 'FIRST_PURCHASE', amountOffCents: 3800 },
          amountDueCents: 15200,
        });
        await d.pay(view.checkoutSessionId);
        expect((await paymentsOf(user))[0].amountCents).toBe(15200);
      });

      it('stays available after a trial, an abandoned checkout and a failed payment, until the first paid purchase', async () => {
        const user = await d.user();
        const api = harness.stripe.api;

        // A free trial is not a purchase.
        await d
          .http()
          .post('/v1/subscription/trial')
          .set('Authorization', harness.bearer(user))
          .expect(201);

        // An abandoned checkout: Stripe expires it and the discount comes back.
        const abandoned = await d.open(user);
        expect(abandoned.discount?.source).toBe('FIRST_PURCHASE');
        await d.abandon(abandoned.checkoutSessionId);
        await expect(
          d.redemption(abandoned.checkoutSessionId),
        ).resolves.toMatchObject({
          status: 'RELEASED',
          releaseReason: 'PROVIDER_EXPIRED',
        });

        // A declined card: the subscription's first invoice stays payable, so
        // the discount is held, even after the session expires...
        const declined = await d.open(user);
        expect(declined.discount?.source).toBe('FIRST_PURCHASE');
        const sessionId = await d.sessionId(declined.checkoutSessionId);
        const invoice = api.failFirstPayment(sessionId);
        await d
          .sendInvoiceEvent('invoice.payment_failed', invoice.id as string)
          .expect(200);
        api.expireByTime(sessionId);
        await d
          .sendSessionEvent('checkout.session.expired', sessionId)
          .expect(200);
        await expect(
          d.redemption(declined.checkoutSessionId),
        ).resolves.toMatchObject({ status: 'RESERVED' });
        // ...until Stripe ends that subscription unpaid.
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
          d.redemption(declined.checkoutSessionId),
        ).resolves.toMatchObject({
          status: 'RELEASED',
          releaseReason: 'SUBSCRIPTION_ENDED',
        });

        // Still the first purchase: the discount applies and is redeemed.
        const paid = await d.open(user);
        expect(paid.discount).toMatchObject({
          source: 'FIRST_PURCHASE',
          amountOffCents: 380,
        });
        await payAndLetExpire(paid.checkoutSessionId);
        await expect(
          d.redemption(paid.checkoutSessionId),
        ).resolves.toMatchObject({ status: 'REDEEMED' });

        // After the first paid purchase it is gone for good.
        const later = await d.open(user);
        expect(later).toMatchObject({ discount: null, amountDueCents: 1900 });
        expect((await redemptionsOf(user)).map((r) => r.status)).toEqual([
          'RELEASED',
          'RELEASED',
          'REDEEMED',
        ]);
      });

      it('is not available again after the first purchase was refunded', async () => {
        const user = await d.user();
        const first = await d.open(user);
        await d.pay(first.checkoutSessionId);
        const row = await d.row(first.checkoutSessionId);
        const payment =
          await harness.client.paymentTransaction.findUniqueOrThrow({
            where: { id: row.paymentId as string },
          });
        harness.stripe.api.refundInvoice(payment.providerInvoiceId as string);
        await d
          .sendSessionEvent(
            'checkout.session.completed',
            await d.sessionId(first.checkoutSessionId),
          )
          .expect(200);
        const charge = harness.stripe.api.chargeOf(
          payment.providerInvoiceId as string,
        );
        const { payload, signature } = harness.stripe.api.signedChargeEvent(
          'charge.refunded',
          charge,
        );
        await harness.sendWebhook(payload, signature).expect(200);
        harness.stripe.api.cancelSubscription(
          row.providerSubscriptionId as string,
        );
        await expect(
          harness.client.paymentTransaction.findUniqueOrThrow({
            where: { id: payment.id },
          }),
        ).resolves.toMatchObject({ status: 'REFUNDED' });

        const again = await d.open(user);
        expect(again.discount).toBeNull();
      });

      it('is not offered while switched off (0%)', async () => {
        await d.setDiscountSettings(admin, { firstPurchaseDiscountPercent: 0 });
        const user = await d.user();
        const view = await d.open(user);
        expect(view).toMatchObject({ discount: null, amountDueCents: 1900 });
        expect(harness.stripe.api.coupons.size).toBe(0);
        await expect(redemptionsOf(user)).resolves.toEqual([]);
      });
    });

    describe('referral discount', () => {
      it('applies to users who signed up with a code; existing accounts cannot be referred', async () => {
        await d.setDiscountSettings(admin, { referralDiscountPercent: 15 });
        const referrer = await d.user();
        const existing = await d.user();
        const { code } = await referralOf(referrer);
        expect(code).toMatch(/^[A-Z0-9]{8}$/);

        // A retrospective referral is refused.
        expect(messageOf(await applyReferral(existing, code).expect(409))).toBe(
          'Referral codes can only be used when signing up',
        );
        await expect(referralOf(existing)).resolves.toMatchObject({
          referred: false,
          referralDiscountPercent: 0,
        });
        await expect(d.open(existing)).resolves.toMatchObject({
          discount: { source: 'FIRST_PURCHASE' },
        });

        const friend = await signUpReferred(referrer);
        await expect(referralOf(friend)).resolves.toMatchObject({
          referred: true,
          referralDiscountPercent: 15,
        });
        await expect(
          harness.client.referral.findUnique({ where: { authId: friend } }),
        ).resolves.toMatchObject({ referrerAuthId: referrer });
      });

      it('gives a referred user the highest of the referral and first-purchase discounts, used once', async () => {
        await d.setDiscountSettings(admin, {
          firstPurchaseDiscountPercent: 10,
          referralDiscountPercent: 25,
        });
        const referrer = await d.user();
        const friend = await signUpReferred(referrer);

        const view = await d.open(friend);
        expect(view.discount).toMatchObject({
          source: 'REFERRAL',
          percent: 25,
          amountOffCents: 475,
        });
        await payAndLetExpire(view.checkoutSessionId);
        expect((await paymentsOf(friend))[0].amountCents).toBe(1425);
        await expect(
          d.redemption(view.checkoutSessionId),
        ).resolves.toMatchObject({
          source: 'REFERRAL',
          status: 'REDEEMED',
        });

        // Neither discount is available after the first paid purchase.
        const next = await d.open(friend);
        expect(next.discount).toBeNull();
        await expect(referralOf(friend)).resolves.toMatchObject({
          referralDiscountPercent: 0,
        });
      });

      it('prefers the first-purchase discount when it is higher or equal', async () => {
        const referrer = await d.user();
        const friend = await signUpReferred(referrer);

        await d.setDiscountSettings(admin, {
          firstPurchaseDiscountPercent: 30,
          referralDiscountPercent: 25,
        });
        const higher = await d.open(friend);
        expect(higher.discount).toMatchObject({
          source: 'FIRST_PURCHASE',
          percent: 30,
        });
        await d.abandon(higher.checkoutSessionId);

        await d.setDiscountSettings(admin, {
          firstPurchaseDiscountPercent: 25,
          referralDiscountPercent: 25,
        });
        const tie = await d.open(friend);
        expect(tie.discount).toMatchObject({
          source: 'FIRST_PURCHASE',
          percent: 25,
        });
      });
    });

    describe('used once', () => {
      it('reserves one discount for concurrent checkout requests of one user', async () => {
        const user = await d.user();

        const responses = await Promise.all(
          Array.from({ length: 6 }, () => d.checkout(user)),
        );

        const created = responses.filter((r) => r.status === 201);
        expect(created.length).toBeGreaterThan(0);
        expect(responses.every((r) => [201, 409].includes(r.status))).toBe(
          true,
        );
        expect(
          new Set(
            created.map(
              (r) => dataOf<{ checkoutSessionId: string }>(r).checkoutSessionId,
            ),
          ).size,
        ).toBe(1);
        const redemptions = await redemptionsOf(user);
        expect(redemptions).toHaveLength(1);
        expect(redemptions[0]).toMatchObject({
          source: 'FIRST_PURCHASE',
          status: 'RESERVED',
        });
      });

      it('redeems once whatever the order and number of payment events', async () => {
        const user = await d.user();
        const view = await d.open(user);
        const sessionId = await d.sessionId(view.checkoutSessionId);
        const api = harness.stripe.api;
        api.completeSession(sessionId);
        const invoiceId = api.sessions.get(sessionId)?.invoice as string;

        // The invoice event first, then the checkout events, all duplicated
        // and delivered concurrently, then replayed again.
        await d.sendInvoiceEvent('invoice.paid', invoiceId).expect(200);
        await Promise.all([
          d.sendSessionEvent('checkout.session.completed', sessionId),
          d.sendSessionEvent('checkout.session.completed', sessionId),
          d.sendSessionEvent(
            'checkout.session.async_payment_succeeded',
            sessionId,
          ),
          d.sendInvoiceEvent('invoice.paid', invoiceId),
        ]);
        await d
          .sendSessionEvent('checkout.session.completed', sessionId)
          .expect(200);

        await expect(paymentsOf(user)).resolves.toHaveLength(1);
        const redemptions = await redemptionsOf(user);
        expect(redemptions).toHaveLength(1);
        expect(redemptions[0]).toMatchObject({
          status: 'REDEEMED',
          discountUsdCents: 380,
        });
      });

      it('has PostgreSQL refuse a second use or a use after the first paid purchase', async () => {
        const user = await d.user();
        const view = await d.open(user);
        const reservation = (await d.redemption(view.checkoutSessionId))!;
        const base = {
          authId: user,
          source: 'FIRST_PURCHASE' as const,
          status: 'RESERVED' as const,
          product: 'PRO_MONTHLY' as const,
          discountPercent: 20,
          originalPriceUsdCents: 1900,
          discountUsdCents: 380,
          finalPriceUsdCents: 1520,
          reservedAt: new Date(),
        };
        await expect(
          harness.client.discountRedemption.create({
            data: { ...base, idempotencyKey: 'second' },
          }),
        ).rejects.toThrow(/Unique constraint|unique/);

        await d.pay(view.checkoutSessionId);
        await expect(
          harness.client.discountRedemption.update({
            where: { id: reservation.id },
            data: { status: 'RELEASED', releasedAt: new Date() },
          }),
        ).rejects.toThrow('cannot change from REDEEMED to RELEASED');
        await expect(
          harness.client.discountRedemption.create({
            data: {
              ...base,
              source: 'REFERRAL',
              idempotencyKey: 'after-purchase',
            },
          }),
        ).rejects.toThrow('only available before the first paid purchase');
      });
    });
  },
);
