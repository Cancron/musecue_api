// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { randomBytes } from 'node:crypto';
import { expectConsistentLedger } from './support/credit-fixtures';
import { FakeStripeApi } from './support/fake-stripe-api';
import { describeWithDatabase } from './support/migrated-schema';
import {
  bootReferralApp,
  dataOf,
  messageOf,
  referralFlows,
  type ReferralApp,
  type SignedUp,
} from './support/referral-flows';
import { givenPaidProHistory } from './support/subscription-fixtures';

jest.setTimeout(240_000);

const HOUR = 60 * 60 * 1000;

/**
 * Referral rewards through the complete application and the Stripe flow:
 * the referrer receives non-expiring REFERRAL credits once, with the invited
 * user's first verified paying purchase, and never for unsuccessful or free
 * purchases, or twice for repeated or concurrent webhook deliveries. The
 * credits give access to POST /v1/sessions without Pro.
 */
describeWithDatabase(
  'Referral rewards on purchase (PostgreSQL, full stack, Stripe)',
  () => {
    let app: ReferralApp;
    let r: ReturnType<typeof referralFlows>;
    let admin: Awaited<ReturnType<ReturnType<typeof referralFlows>['admin']>>;

    /** A referrer and a user who signed up with the referrer's code. */
    const referred = async (): Promise<{
      referrer: SignedUp;
      friend: SignedUp;
    }> => {
      const referrer = await r.signUp({ prefix: 'ref' });
      const friend = await r.signUp({
        prefix: 'fr',
        referralCode: await r.codeOf(referrer),
      });
      return { referrer, friend };
    };
    const balanceOf = async (account: SignedUp) =>
      dataOf<{
        available: string;
        sources: Array<{
          source: string;
          granted: string;
          expires: boolean;
          usableNow: boolean;
        }>;
      }>(await r.get(account, '/v1/credits/balance').expect(200));

    beforeAll(async () => {
      app = await bootReferralApp();
      r = referralFlows(app);
      admin = await r.admin();
    });

    beforeEach(async () => {
      app.stripe.api = new FakeStripeApi(5);
      await r.setDiscountSettings(admin, {
        firstPurchaseDiscountPercent: 0,
        referralDiscountPercent: 15,
        referrerRewardCredits: 100,
      });
    });

    afterAll(async () => {
      await app?.ctx.close();
    });

    it('grants the referrer non-expiring REFERRAL credits with the invited user’s first verified paid purchase', async () => {
      const { referrer, friend } = await referred();

      const purchase = await r.buyPro(friend);

      expect(purchase.checkout).toMatchObject({
        discount: { source: 'REFERRAL' },
        amountDueCents: 1615,
      });
      const payment = await app.ctx.client.paymentTransaction.findFirstOrThrow({
        where: { subscription: { authId: friend.id }, status: 'SUCCEEDED' },
      });
      const referral = await r.referralOf(friend.id);
      expect(referral).toMatchObject({
        status: 'REWARDED',
        qualifyingPaymentId: payment.id,
        rewardCredits: 100,
      });
      const [reward, ...others] = await r.rewardAllocations(referrer.id);
      expect(others).toEqual([]);
      expect(reward).toMatchObject({
        source: 'REFERRAL',
        sourceReference: `referral-reward:${referral!.id}`,
        expiresAt: null,
      });
      expect(reward.amount.toFixed()).toBe('100');
      const balance = await balanceOf(referrer);
      expect(balance.available).toBe('100');
      expect(
        balance.sources.find((s) => s.source === 'REFERRAL'),
      ).toMatchObject({
        granted: '100',
        expires: false,
        usableNow: true,
      });
      // The invited user receives no referral credits.
      await expect(r.rewardAllocations(friend.id)).resolves.toEqual([]);
      await expectConsistentLedger(app.ctx.client, referrer.id);
    });

    it('grants nothing for abandoned, declined or failed delayed purchases, then rewards the successful one', async () => {
      const { referrer, friend } = await referred();
      const api = () => app.stripe.api;
      const pending = async () => {
        await expect(r.referralOf(friend.id)).resolves.toMatchObject({
          status: 'PENDING',
        });
        await expect(r.rewardAllocations(referrer.id)).resolves.toEqual([]);
      };

      // Abandoned: the session expires.
      const abandoned = await r.checkout(friend);
      const abandonedSession = await r.sessionId(abandoned.checkoutSessionId);
      api().expireByTime(abandonedSession);
      await r
        .sessionEvent('checkout.session.expired', abandonedSession)
        .expect(200);
      await pending();

      // Declined card, then the session expires.
      const declined = await r.checkout(friend);
      const declinedSession = await r.sessionId(declined.checkoutSessionId);
      const invoice = api().failFirstPayment(declinedSession);
      await r
        .invoiceEvent('invoice.payment_failed', invoice.id as string)
        .expect(200);
      api().expireByTime(declinedSession);
      await r
        .sessionEvent('checkout.session.expired', declinedSession)
        .expect(200);
      await pending();
      const subscription = api().sessions.get(declinedSession)
        ?.subscription as string;
      api().expireIncompleteSubscription(subscription);
      await r
        .webhook(
          api().signedSubscriptionEvent(
            'customer.subscription.deleted',
            subscription,
          ),
        )
        .expect(200);

      // A delayed payment method that fails.
      const delayed = await r.checkout(friend);
      const delayedSession = await r.sessionId(delayed.checkoutSessionId);
      api().completeSession(delayedSession, { paymentStatus: 'unpaid' });
      await r
        .sessionEvent('checkout.session.completed', delayedSession)
        .expect(200);
      await r
        .sessionEvent('checkout.session.async_payment_failed', delayedSession)
        .expect(200);
      await pending();
      const delayedSubscription = api().sessions.get(delayedSession)
        ?.subscription as string;
      api().subscriptions.get(delayedSubscription)!.status = 'incomplete';
      api().expireIncompleteSubscription(delayedSubscription);
      await r
        .webhook(
          api().signedSubscriptionEvent(
            'customer.subscription.deleted',
            delayedSubscription,
          ),
        )
        .expect(200);

      // The successful purchase.
      await r.buyPro(friend);
      await expect(r.referralOf(friend.id)).resolves.toMatchObject({
        status: 'REWARDED',
      });
      expect(
        (await r.rewardAllocations(referrer.id)).map((a) => a.amount.toFixed()),
      ).toEqual(['100']);
    });

    it('rewards once for repeated, out-of-order and concurrent webhook deliveries', async () => {
      const { referrer, friend } = await referred();
      const checkout = await r.checkout(friend);
      const sessionId = await r.sessionId(checkout.checkoutSessionId);
      app.stripe.api.completeSession(sessionId);
      const invoiceId = app.stripe.api.sessions.get(sessionId)
        ?.invoice as string;

      // The invoice event first, then everything duplicated and concurrent.
      await r.invoiceEvent('invoice.paid', invoiceId).expect(200);
      const responses = await Promise.all([
        r.sessionEvent('checkout.session.completed', sessionId),
        r.sessionEvent('checkout.session.completed', sessionId),
        r.sessionEvent('checkout.session.async_payment_succeeded', sessionId),
        r.invoiceEvent('invoice.paid', invoiceId),
        r.invoiceEvent('invoice.paid', invoiceId),
      ]);
      expect(responses.map((res) => res.status)).toEqual([
        200, 200, 200, 200, 200,
      ]);
      await r.sessionEvent('checkout.session.completed', sessionId).expect(200);

      expect(
        (await r.rewardAllocations(referrer.id)).map((a) => a.amount.toFixed()),
      ).toEqual(['100']);
      await expect(
        app.ctx.client.creditTransaction.count({
          where: { authId: referrer.id, type: 'GRANT' },
        }),
      ).resolves.toBe(1);
      await expectConsistentLedger(app.ctx.client, referrer.id);
    });

    it('rewards only the first paying purchase of each invited user', async () => {
      const { referrer, friend } = await referred();
      const purchase = await r.buyPro(friend);
      // The renewal is a verified paid purchase too, but not the first one.
      const renewal = app.stripe.api.renewSubscription(purchase.subscriptionId);
      await r.invoiceEvent('invoice.paid', renewal.id as string).expect(200);
      await expect(
        app.ctx.client.paymentTransaction.count({
          where: { subscription: { authId: friend.id }, status: 'SUCCEEDED' },
        }),
      ).resolves.toBe(2);

      // A second invited user earns a second reward.
      const second = await r.signUp({
        prefix: 'fr2',
        referralCode: await r.codeOf(referrer),
      });
      await r.buyPro(second);

      expect(
        (await r.rewardAllocations(referrer.id)).map((a) => a.amount.toFixed()),
      ).toEqual(['100', '100']);
      expect((await balanceOf(referrer)).available).toBe('200');
    });

    it('charges exactly $0 for a 100% discount, without rewarding; the first paying renewal rewards', async () => {
      const { referrer, friend } = await referred();
      const code = `FREE-${randomBytes(3).toString('hex').toUpperCase()}`;
      await r
        .post(admin, '/v1/admin/discount-codes', {
          code,
          discountPercent: 100,
          startsAt: new Date(Date.now() - HOUR).toISOString(),
          endsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
        })
        .expect(201);

      const purchase = await r.buyPro(friend, {
        billingInterval: 'MONTHLY',
        discountCode: code,
      });

      // $0.00, not Stripe's $0.50 minimum: the coupon covers the whole price.
      expect(purchase.checkout).toMatchObject({
        discount: { source: 'CODE', amountOffCents: 1900 },
        amountDueCents: 0,
      });
      const session = app.stripe.api.sessions.get(purchase.sessionId) as Record<
        string,
        unknown
      >;
      expect(session).toMatchObject({
        amount_total: 0,
        payment_status: 'no_payment_required',
      });
      const payment = await app.ctx.client.paymentTransaction.findFirstOrThrow({
        where: { subscription: { authId: friend.id } },
      });
      expect(payment).toMatchObject({ status: 'SUCCEEDED', amountCents: 0 });
      await expect(
        r.get(friend, '/v1/subscription').expect(200).then(dataOf),
      ).resolves.toMatchObject({
        status: 'PRO',
      });
      // A free purchase is not a paying purchase: no reward yet.
      await expect(r.referralOf(friend.id)).resolves.toMatchObject({
        status: 'PENDING',
      });
      await expect(r.rewardAllocations(referrer.id)).resolves.toEqual([]);

      // The first renewal is charged the full price: that one rewards.
      const renewal = app.stripe.api.renewSubscription(purchase.subscriptionId);
      expect(renewal.amount_paid).toBe(1900);
      await r.invoiceEvent('invoice.paid', renewal.id as string).expect(200);
      await expect(r.referralOf(friend.id)).resolves.toMatchObject({
        status: 'REWARDED',
        rewardCredits: 100,
      });
      expect(
        (await r.rewardAllocations(referrer.id)).map((a) => a.amount.toFixed()),
      ).toEqual(['100']);
    });

    it('qualifies without credits while the reward is switched off, and never rewards that referral later', async () => {
      await r.setDiscountSettings(admin, { referrerRewardCredits: 0 });
      const { referrer, friend } = await referred();
      const purchase = await r.buyPro(friend);
      await expect(r.referralOf(friend.id)).resolves.toMatchObject({
        status: 'QUALIFIED',
        rewardCredits: null,
      });

      await r.setDiscountSettings(admin, { referrerRewardCredits: 100 });
      const renewal = app.stripe.api.renewSubscription(purchase.subscriptionId);
      await r.invoiceEvent('invoice.paid', renewal.id as string).expect(200);
      await expect(r.referralOf(friend.id)).resolves.toMatchObject({
        status: 'QUALIFIED',
      });
      await expect(r.rewardAllocations(referrer.id)).resolves.toEqual([]);
    });

    it('lets referral credits open makeup sessions after the referrer’s Pro subscription ended', async () => {
      const { referrer, friend } = await referred();
      // The referrer was Pro, and the paid term is over.
      await givenPaidProHistory(
        app.ctx.client,
        referrer.id,
        {
          billingInterval: 'MONTHLY',
          startedAt: new Date(Date.now() - 90 * 24 * HOUR),
        },
        new Date(),
      );
      await expect(
        r.get(referrer, '/v1/subscription').expect(200).then(dataOf),
      ).resolves.toMatchObject({
        status: 'EXPIRED',
        hasProAccess: false,
      });
      expect(
        messageOf(await r.post(referrer, '/v1/sessions').expect(403)),
      ).toBe('Insufficient credits');

      await r.buyPro(friend);

      await r.post(referrer, '/v1/sessions').expect(201);
      await expect(
        app.ctx.client.makeupSession.count({ where: { authId: referrer.id } }),
      ).resolves.toBe(1);
    });

    it('has PostgreSQL refuse referral reward credits without a rewarded referral, or twice', async () => {
      const { referrer, friend } = await referred();
      const wallet = await app.ctx.client.creditWallet.upsert({
        where: { authId: referrer.id },
        create: { authId: referrer.id },
        update: {},
      });
      const referral = (await r.referralOf(friend.id))!;
      const allocation = (amount: number) => ({
        walletId: wallet.id,
        authId: referrer.id,
        source: 'REFERRAL' as const,
        sourceReference: `referral-reward:${referral.id}`,
        amount,
        remaining: amount,
        grantedAt: new Date(),
      });
      // Pending: no reward can be written.
      await expect(
        app.ctx.client.creditAllocation.create({ data: allocation(100) }),
      ).rejects.toThrow('Referral reward credits require a rewarded referral');

      await r.buyPro(friend);
      // Rewarded: neither another amount nor a second grant.
      await expect(
        app.ctx.client.creditAllocation.create({ data: allocation(500) }),
      ).rejects.toThrow();
      await expect(
        app.ctx.client.creditAllocation.create({ data: allocation(100) }),
      ).rejects.toThrow();
      await expect(
        app.ctx.client.referral.update({
          where: { id: referral.id },
          data: { status: 'QUALIFIED', rewardCredits: null, rewardedAt: null },
        }),
      ).rejects.toThrow('rewarded or qualified only once');
      expect(
        (await r.rewardAllocations(referrer.id)).map((a) => a.amount.toFixed()),
      ).toEqual(['100']);
    });
  },
);
