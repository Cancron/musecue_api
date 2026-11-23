// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { randomBytes } from 'node:crypto';
import { CreditPackageSettingsService } from '../src/credit-packages/credit-package-settings.service';
import { expectConsistentLedger } from './support/credit-fixtures';
import {
  creditPackageFlows,
  type OrderView,
} from './support/credit-package-flows';
import type { TestAccount } from './support/discount-fixtures';
import { FakeStripeApi } from './support/fake-stripe-api';
import { describeWithDatabase } from './support/migrated-schema';
import {
  bootReferralApp,
  dataOf,
  messageOf,
  type ReferralApp,
  type SignedUp,
} from './support/referral-flows';

jest.setTimeout(300_000);

const PACKAGES = '/v1/credit-packages';
const ORDERS = '/v1/credit-package-orders';

/**
 * Buying credit packages through the complete application and the Stripe
 * flow (the real Stripe SDK against FakeStripeApi, signed webhooks): the
 * configured packages at their configured prices, terms locked with the
 * order, discounts and referrals, credits granted only for verified
 * successful payments and exactly once.
 */
describeWithDatabase(
  'Credit package payments (PostgreSQL, full stack, Stripe)',
  () => {
    let app: ReferralApp;
    let p: ReturnType<typeof creditPackageFlows>;
    let admin: TestAccount;

    const setPackage = (code: string, body: Record<string, unknown>) =>
      p
        .patch(admin, `/v1/admin/credit-package-settings/${code}`, body)
        .expect(200);
    const balanceOf = async (account: TestAccount) =>
      dataOf<{
        available: string;
        sources: Array<{
          source: string;
          granted: string;
          available: string;
          expires: boolean;
          usableNow: boolean;
        }>;
      }>(await p.get(account, '/v1/credits/balance').expect(200));
    const createCode = async (body: Record<string, unknown>) =>
      dataOf<{ id: string; code: string }>(
        await p
          .post(admin, '/v1/admin/discount-codes', {
            code: `PKG${randomBytes(4).toString('hex')}`.toUpperCase(),
            startsAt: new Date(Date.now() - 60_000).toISOString(),
            endsAt: new Date(Date.now() + 86_400_000).toISOString(),
            ...body,
          })
          .expect(201),
      );

    beforeAll(async () => {
      app = await bootReferralApp();
      p = creditPackageFlows(app);
      admin = await p.admin();
    });

    beforeEach(async () => {
      app.stripe.api = new FakeStripeApi(5);
      await p.setDiscountSettings(admin, {
        firstPurchaseDiscountPercent: 0,
        referralDiscountPercent: 0,
        referrerRewardCredits: 0,
      });
      // The default packages: 250 for $5, 500 for $10, 1000 for $20.
      await app.ctx.client.creditPackage.deleteMany();
      await app.ctx
        .get<CreditPackageSettingsService>(CreditPackageSettingsService)
        .ensureDefaults();
    });

    afterAll(async () => {
      await app?.ctx.close();
    });

    describe('buying', () => {
      it('lists the available packages and charges the configured USD price through Stripe, granting the configured credits once paid', async () => {
        const user = await p.signUp({ prefix: 'buy' });
        expect(
          dataOf<unknown[]>(await p.get(user, PACKAGES).expect(200)),
        ).toEqual([
          {
            code: 'SMALL',
            credits: 250,
            priceUsdCents: 500,
            priceUsd: '5.00',
            currency: 'USD',
          },
          {
            code: 'MEDIUM',
            credits: 500,
            priceUsdCents: 1000,
            priceUsd: '10.00',
            currency: 'USD',
          },
          {
            code: 'LARGE',
            credits: 1000,
            priceUsdCents: 2000,
            priceUsd: '20.00',
            currency: 'USD',
          },
        ]);

        const order = await p.orderPackage(user, 'medium');
        expect(order).toMatchObject({
          status: 'OPEN',
          packageCode: 'MEDIUM',
          credits: 500,
          listPriceUsdCents: 1000,
          discount: null,
          amountDueUsdCents: 1000,
          replayed: false,
        });
        expect(order.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com/);
        // The Stripe session charges exactly the configured price.
        const sessionId = await p.sessionOf(order.id);
        const session = app.stripe.api.sessions.get(sessionId)!;
        expect(session).toMatchObject({
          mode: 'payment',
          amount_total: 1000,
          currency: 'usd',
          metadata: { creditPackageOrderId: order.id },
        });
        // Nothing is granted before a verified payment.
        expect(await p.packageCredits(user.id)).toEqual([]);

        await p.payOrder(order.id);
        expect(await p.packageCredits(user.id)).toEqual([]);
        await p
          .sessionEvent('checkout.session.completed', sessionId)
          .expect(200);

        expect(await p.packageCredits(user.id)).toEqual([
          {
            reference: `credit-package:${order.id}`,
            amount: '500',
            expiresAt: null,
          },
        ]);
        await expect(p.orderRow(order.id)).resolves.toMatchObject({
          status: 'PAID',
          amountUsdCents: 1000,
          providerPaymentIntentId: expect.stringMatching(/^pi_/) as unknown,
        });
        const balance = await balanceOf(user);
        expect(balance.available).toBe('500');
        expect(
          balance.sources.find((s) => s.source === 'PURCHASE'),
        ).toMatchObject({ granted: '500', expires: false, usableNow: true });
        expect(
          dataOf<OrderView>(
            await p.get(user, `${ORDERS}/${order.id}`).expect(200),
          ),
        ).toMatchObject({ status: 'PAID', checkoutUrl: null });
        await expectConsistentLedger(app.ctx.client, user.id);
      });

      it('locks the package terms with the order: later configuration changes apply to new orders only', async () => {
        const user = await p.signUp({ prefix: 'lock' });
        const locked = await p.orderPackage(user, 'SMALL');
        await setPackage('SMALL', { credits: 300, priceUsdCents: 700 });

        const next = await p.orderPackage(user, 'SMALL');
        expect(next).toMatchObject({ credits: 300, amountDueUsdCents: 700 });
        // The first order is paid at its own terms.
        const sessionId = await p.payOrder(locked.id);
        expect(app.stripe.api.sessions.get(sessionId)?.amount_total).toBe(500);
        await p
          .sessionEvent('checkout.session.completed', sessionId)
          .expect(200);
        expect((await p.packageCredits(user.id)).map((c) => c.amount)).toEqual([
          '250',
        ]);
        // PostgreSQL refuses to change an order's terms.
        await expect(
          app.ctx.client.creditPackageOrder.update({
            where: { id: next.id },
            data: { credits: 5000 },
          }),
        ).rejects.toThrow('The terms of a credit package order cannot change');
      });

      it('refuses unavailable and unknown packages, missing idempotency keys and anonymous or inactive buyers', async () => {
        const user = await p.signUp({ prefix: 'refuse' });
        await setPackage('LARGE', { available: false });
        expect(
          dataOf<Array<{ code: string }>>(
            await p.get(user, PACKAGES).expect(200),
          ).map((x) => x.code),
        ).toEqual(['SMALL', 'MEDIUM']);
        expect(
          messageOf(await p.checkoutRequest(user, 'LARGE').expect(409)),
        ).toBe('This credit package is not available');
        await p.checkoutRequest(user, 'HUGE').expect(404);
        expect(
          messageOf(
            await p.checkoutRequest(user, 'SMALL', { key: null }).expect(400),
          ),
        ).toMatch(/Idempotency-Key/);
        await p
          .http()
          .post(`${PACKAGES}/SMALL/checkout`)
          .set('Idempotency-Key', 'k')
          .expect(401);
        for (const body of [
          { discountCode: '' },
          { discountCode: 5 },
          { x: 1 },
        ]) {
          await p
            .http()
            .post(`${PACKAGES}/SMALL/checkout`)
            .set('Authorization', p.as(user))
            .set('Idempotency-Key', p.newKey())
            .send(body)
            .expect(400);
        }
        await app.ctx.client.authUser.update({
          where: { id: user.id },
          data: { verified: false },
        });
        await p.checkoutRequest(user, 'SMALL').expect(403);
        await expect(
          app.ctx.client.creditPackageOrder.count({
            where: { authId: user.id },
          }),
        ).resolves.toBe(0);
        // PostgreSQL refuses an order for an unavailable package or with
        // other terms than configured.
        await expect(
          app.ctx.client.creditPackageOrder.create({
            data: {
              authId: user.id,
              idempotencyKey: 'manual',
              packageCode: 'SMALL',
              credits: 100_000,
              listPriceUsdCents: 500,
              amountUsdCents: 500,
              provider: 'stripe',
              providerCustomerId: 'cus_x',
            },
          }),
        ).rejects.toThrow('current terms of an available package');
      });

      it('returns the same order for repeated and concurrent requests with one Idempotency-Key', async () => {
        const user = await p.signUp({ prefix: 'idem' });
        const key = p.newKey();
        const responses = await Promise.all(
          Array.from({ length: 6 }, () =>
            p.checkoutRequest(user, 'SMALL', { key }),
          ),
        );
        expect(responses.map((res) => res.status)).toEqual(
          Array<number>(6).fill(201),
        );
        const ids = new Set(responses.map((res) => dataOf<OrderView>(res).id));
        expect(ids.size).toBe(1);
        const again = dataOf<OrderView>(
          await p.checkoutRequest(user, 'SMALL', { key }).expect(201),
        );
        expect(again).toMatchObject({ id: [...ids][0], replayed: true });
        expect(
          app.stripe.api.count('POST', '/v1/checkout/sessions'),
        ).toBeGreaterThanOrEqual(1);
        expect(app.stripe.api.sessions.size).toBe(1);
        // The same key for another purchase is refused.
        expect(
          messageOf(
            await p.checkoutRequest(user, 'LARGE', { key }).expect(409),
          ),
        ).toBe('This Idempotency-Key was already used for another purchase');
        await expect(
          app.ctx.client.creditPackageOrder.count({
            where: { authId: user.id },
          }),
        ).resolves.toBe(1);
      });
    });

    describe('only verified successful payments grant credits, once', () => {
      it('grants once for repeated, out-of-order and concurrent webhook deliveries', async () => {
        const user = await p.signUp({ prefix: 'once' });
        const order = await p.orderPackage(user, 'SMALL');
        const sessionId = await p.payOrder(order.id);
        const responses = await Promise.all([
          p.sessionEvent('checkout.session.async_payment_succeeded', sessionId),
          p.sessionEvent('checkout.session.completed', sessionId),
          p.sessionEvent('checkout.session.completed', sessionId),
          p.sessionEvent('checkout.session.completed', sessionId),
        ]);
        expect(responses.map((res) => res.status)).toEqual([
          200, 200, 200, 200,
        ]);
        await p
          .sessionEvent('checkout.session.completed', sessionId)
          .expect(200);
        // An expiry event after the payment changes nothing.
        await p.sessionEvent('checkout.session.expired', sessionId).expect(200);

        expect((await p.packageCredits(user.id)).map((c) => c.amount)).toEqual([
          '250',
        ]);
        await expect(
          app.ctx.client.creditTransaction.count({
            where: { authId: user.id, type: 'GRANT' },
          }),
        ).resolves.toBe(1);
        await expect(p.orderRow(order.id)).resolves.toMatchObject({
          status: 'PAID',
        });
        // Two separate purchases are two grants.
        await p.buyPackage(user, 'SMALL');
        expect((await p.packageCredits(user.id)).map((c) => c.amount)).toEqual([
          '250',
          '250',
        ]);
        await expectConsistentLedger(app.ctx.client, user.id);
      });

      it('grants nothing for abandoned, canceled, failed or unsettled payments', async () => {
        const user = await p.signUp({ prefix: 'nopay' });
        const api = () => app.stripe.api;

        // Abandoned: the session expires.
        const abandoned = await p.orderPackage(user, 'SMALL');
        const abandonedSession = await p.sessionOf(abandoned.id);
        api().expireByTime(abandonedSession);
        await p
          .sessionEvent('checkout.session.expired', abandonedSession)
          .expect(200);
        await expect(p.orderRow(abandoned.id)).resolves.toMatchObject({
          status: 'EXPIRED',
          closedReason: 'PROVIDER_EXPIRED',
        });

        // Canceled by the user: Stripe expires the session first.
        const canceled = await p.orderPackage(user, 'MEDIUM');
        const canceledView = dataOf<OrderView>(
          await p.post(user, `${ORDERS}/${canceled.id}/cancel`).expect(200),
        );
        expect(canceledView).toMatchObject({
          status: 'CANCELED',
          closedReason: 'CANCELED_BY_USER',
          checkoutUrl: null,
        });
        expect(api().sessions.get(await p.sessionOf(canceled.id))?.status).toBe(
          'expired',
        );
        await p.post(user, `${ORDERS}/${canceled.id}/cancel`).expect(200);

        // A delayed payment method that fails.
        const delayed = await p.orderPackage(user, 'LARGE');
        const delayedSession = await p.payOrder(delayed.id, {
          paymentStatus: 'unpaid',
        });
        await p
          .sessionEvent('checkout.session.completed', delayedSession)
          .expect(200);
        await expect(p.orderRow(delayed.id)).resolves.toMatchObject({
          status: 'PROCESSING',
        });
        await p.post(user, `${ORDERS}/${delayed.id}/cancel`).expect(409);
        api().failDelayedPayment(delayedSession);
        await p
          .sessionEvent('checkout.session.async_payment_failed', delayedSession)
          .expect(200);
        await expect(p.orderRow(delayed.id)).resolves.toMatchObject({
          status: 'FAILED',
          closedReason: 'ASYNC_PAYMENT_FAILED',
        });

        // Unverified: an event claiming a payment Stripe does not confirm.
        const unpaid = await p.orderPackage(user, 'SMALL');
        const unpaidSession = await p.sessionOf(unpaid.id);
        await p
          .webhook(
            api().signedEvent('checkout.session.completed', unpaidSession, {
              status: 'complete',
              payment_status: 'paid',
            }),
          )
          .expect(200);
        // A forged (unsigned) event is refused.
        await p
          .http()
          .post('/v1/webhooks/stripe')
          .set('Content-Type', 'application/json')
          .set('Stripe-Signature', 't=1,v1=forged')
          .send(
            JSON.stringify({
              type: 'checkout.session.completed',
              data: { object: { id: unpaidSession } },
            }),
          )
          .expect(400);

        expect(await p.packageCredits(user.id)).toEqual([]);
        expect((await balanceOf(user)).available).toBe('0');

        // A payment of another amount than the order's is rejected.
        const tampered = await p.orderPackage(user, 'SMALL');
        const tamperedSession = await p.sessionOf(tampered.id);
        api().completeSession(tamperedSession);
        api().sessions.get(tamperedSession)!.amount_total = 100;
        await p
          .sessionEvent('checkout.session.completed', tamperedSession)
          .expect(200);
        expect(await p.packageCredits(user.id)).toEqual([]);
        await expect(p.orderRow(tampered.id)).resolves.toMatchObject({
          status: 'OPEN',
        });

        // The delayed payment that settles is granted.
        const settles = await p.orderPackage(user, 'SMALL');
        const settlesSession = await p.payOrder(settles.id, {
          paymentStatus: 'unpaid',
        });
        await p
          .sessionEvent('checkout.session.completed', settlesSession)
          .expect(200);
        expect(await p.packageCredits(user.id)).toEqual([]);
        api().settleDelayedPayment(settlesSession);
        await p
          .sessionEvent(
            'checkout.session.async_payment_succeeded',
            settlesSession,
          )
          .expect(200);
        expect((await p.packageCredits(user.id)).map((c) => c.amount)).toEqual([
          '250',
        ]);
      });

      it('has PostgreSQL refuse package credits without a paid order, and a paid order without its credits', async () => {
        const user = await p.signUp({ prefix: 'dbguard' });
        const { order } = await p.buyPackage(user, 'SMALL');
        const open = await p.orderPackage(user, 'MEDIUM');
        const wallet = await app.ctx.client.creditWallet.findUniqueOrThrow({
          where: { authId: user.id },
        });
        const allocate = (orderId: string, amount: number) =>
          app.ctx.client.creditAllocation.create({
            data: {
              walletId: wallet.id,
              authId: user.id,
              source: 'PURCHASE',
              sourceReference: `credit-package:${orderId}`,
              amount,
              remaining: amount,
              grantedAt: new Date(),
            },
          });
        // An unpaid order, or another amount.
        await expect(allocate(open.id, 500)).rejects.toThrow(
          'Credit package credits require a paid order',
        );
        await expect(allocate(order.id, 9999)).rejects.toThrow();
        // Marking an order paid without granting its credits.
        await expect(
          app.ctx.client.creditPackageOrder.update({
            where: { id: open.id },
            data: {
              status: 'PAID',
              paidAt: new Date(),
              providerPaymentIntentId: 'pi_forged',
            },
          }),
        ).rejects.toThrow('A paid credit package order must grant its credits');
        // A paid order never changes status again, and orders are kept.
        await expect(
          app.ctx.client.creditPackageOrder.update({
            where: { id: order.id },
            data: { status: 'FAILED', closedAt: new Date(), closedReason: 'x' },
          }),
        ).rejects.toThrow();
        await expect(
          app.ctx.client.creditPackageOrder.delete({ where: { id: order.id } }),
        ).rejects.toThrow('cannot be deleted');
        expect((await p.packageCredits(user.id)).map((c) => c.amount)).toEqual([
          '250',
        ]);
      });
    });

    describe('discounts and referrals', () => {
      it('applies the first-purchase discount until the first paid purchase, which a package purchase is', async () => {
        await p.setDiscountSettings(admin, {
          firstPurchaseDiscountPercent: 20,
          referralDiscountPercent: 0,
          referrerRewardCredits: 0,
        });
        const user = await p.signUp({ prefix: 'first' });
        // An abandoned order gives its discount back.
        const abandoned = await p.orderPackage(user, 'MEDIUM');
        expect(abandoned).toMatchObject({
          discount: {
            source: 'FIRST_PURCHASE',
            percent: 20,
            amountOffCents: 200,
          },
          amountDueUsdCents: 800,
        });
        const abandonedSession = await p.sessionOf(abandoned.id);
        app.stripe.api.expireByTime(abandonedSession);
        await p
          .sessionEvent('checkout.session.expired', abandonedSession)
          .expect(200);

        const { order, sessionId } = await p.buyPackage(user, 'MEDIUM');
        expect(order).toMatchObject({
          discount: { source: 'FIRST_PURCHASE', amountOffCents: 200 },
          amountDueUsdCents: 800,
        });
        // Stripe charged the discounted amount (one-time coupon).
        expect(app.stripe.api.sessions.get(sessionId!)).toMatchObject({
          amount_subtotal: 1000,
          amount_total: 800,
        });
        // Full credits for the discounted price.
        expect((await p.packageCredits(user.id)).map((c) => c.amount)).toEqual([
          '500',
        ]);
        await expect(
          app.ctx.client.discountRedemption.findMany({
            where: { authId: user.id },
            orderBy: { createdAt: 'asc' },
          }),
        ).resolves.toMatchObject([
          { source: 'FIRST_PURCHASE', status: 'RELEASED' },
          {
            source: 'FIRST_PURCHASE',
            status: 'REDEEMED',
            packageOrderId: order.id,
          },
        ]);

        // The package purchase was the first paid purchase: neither another
        // package nor Pro gets the first-purchase discount.
        expect((await p.orderPackage(user, 'SMALL')).discount).toBeNull();
        expect((await p.checkout(user)).discount).toBeNull();
      });

      it('applies entered discount codes; a fully discounted package is granted without a charge', async () => {
        const user = await p.signUp({ prefix: 'code' });
        const half = await createCode({ discountPercent: 50 });
        const { order } = await p.buyPackage(user, 'LARGE', {
          discountCode: half.code.toLowerCase(),
        });
        expect(order).toMatchObject({
          discount: { source: 'CODE', percent: 50, code: half.code },
          amountDueUsdCents: 1000,
        });
        expect((await p.packageCredits(user.id)).map((c) => c.amount)).toEqual([
          '1000',
        ]);

        const free = await createCode({ discountPercent: 100 });
        const sessionsBefore = app.stripe.api.sessions.size;
        const freeOrder = await p.orderPackage(user, 'SMALL', {
          discountCode: free.code,
        });
        expect(freeOrder).toMatchObject({
          status: 'PAID',
          amountDueUsdCents: 0,
          checkoutUrl: null,
        });
        expect(app.stripe.api.sessions.size).toBe(sessionsBefore);
        expect(
          (await p.packageCredits(user.id)).map((c) => c.amount).sort(),
        ).toEqual(['1000', '250']);

        // Unknown or unusable codes are refused and create nothing.
        await p
          .checkoutRequest(user, 'SMALL', { discountCode: 'NO-SUCH-CODE' })
          .expect(404);
        await p
          .checkoutRequest(user, 'SMALL', { discountCode: free.code })
          .expect(409);
        const pro = await createCode({
          discountPercent: 30,
          eligibleProducts: ['PRO_MONTHLY'],
        });
        await p
          .checkoutRequest(user, 'SMALL', { discountCode: pro.code })
          .expect(409);
        await expect(
          app.ctx.client.creditPackageOrder.count({
            where: { authId: user.id },
          }),
        ).resolves.toBe(2);
      });

      it('gives referred users the referral discount and rewards the referrer once for the first paid package purchase', async () => {
        await p.setDiscountSettings(admin, {
          firstPurchaseDiscountPercent: 0,
          referralDiscountPercent: 10,
          referrerRewardCredits: 75,
        });
        const referrer = await p.signUp({ prefix: 'ref' });
        const friend: SignedUp = await p.signUp({
          prefix: 'fr',
          referralCode: await p.codeOf(referrer),
        });

        const { order } = await p.buyPackage(friend, 'MEDIUM');
        expect(order).toMatchObject({
          discount: { source: 'REFERRAL', percent: 10, amountOffCents: 100 },
          amountDueUsdCents: 900,
        });
        await expect(p.referralOf(friend.id)).resolves.toMatchObject({
          status: 'REWARDED',
          qualifyingPackageOrderId: order.id,
          qualifyingPaymentId: null,
          rewardCredits: 75,
        });
        expect(
          (await p.rewardAllocations(referrer.id)).map((a) =>
            a.amount.toFixed(),
          ),
        ).toEqual(['75']);

        // Later purchases (a package, then Pro) never reward again.
        await p.buyPackage(friend, 'SMALL');
        await p.buyPro(friend);
        expect(
          (await p.rewardAllocations(referrer.id)).map((a) =>
            a.amount.toFixed(),
          ),
        ).toEqual(['75']);
        expect(
          (await p.notificationsOf(referrer.id)).filter(
            (n) => n.type === 'REFERRAL_REWARD_EARNED',
          ),
        ).toHaveLength(1);
      });

      it('never rewards a referral for a fully discounted (free) package', async () => {
        await p.setDiscountSettings(admin, {
          firstPurchaseDiscountPercent: 0,
          referralDiscountPercent: 0,
          referrerRewardCredits: 50,
        });
        const referrer = await p.signUp({ prefix: 'ref0' });
        const friend = await p.signUp({
          prefix: 'fr0',
          referralCode: await p.codeOf(referrer),
        });
        const free = await createCode({ discountPercent: 100 });
        await p.orderPackage(friend, 'SMALL', { discountCode: free.code });
        await expect(p.referralOf(friend.id)).resolves.toMatchObject({
          status: 'PENDING',
        });
        expect(await p.rewardAllocations(referrer.id)).toEqual([]);
        // The first paying purchase does.
        await p.buyPackage(friend, 'SMALL');
        await expect(p.referralOf(friend.id)).resolves.toMatchObject({
          status: 'REWARDED',
        });
      });
    });

    describe('ownership', () => {
      it('shows and cancels only the caller’s own orders', async () => {
        const owner = await p.signUp({ prefix: 'own' });
        const other = await p.signUp({ prefix: 'oth' });
        const order = await p.orderPackage(owner, 'SMALL');

        expect(
          dataOf<OrderView[]>(await p.get(owner, ORDERS).expect(200)).map(
            (o) => o.id,
          ),
        ).toEqual([order.id]);
        expect(
          dataOf<OrderView[]>(await p.get(other, ORDERS).expect(200)),
        ).toEqual([]);
        await p.get(other, `${ORDERS}/${order.id}`).expect(404);
        await p.post(other, `${ORDERS}/${order.id}/cancel`).expect(404);
        await p.get(owner, `${ORDERS}?userId=${other.id}`).expect(400);
        await p.http().get(ORDERS).expect(401);
        await expect(p.orderRow(order.id)).resolves.toMatchObject({
          status: 'OPEN',
        });
      });
    });
  },
);
