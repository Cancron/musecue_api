// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { CreditPackageSettingsService } from '../src/credit-packages/credit-package-settings.service';
import { CreditFulfillmentWorker } from '../src/credit-packages/fulfillment/credit-fulfillment.worker';
import { expectConsistentLedger } from './support/credit-fixtures';
import {
  creditPackageFlows,
  type GiftView,
  type OrderView,
} from './support/credit-package-flows';
import { createAccount, type TestAccount } from './support/discount-fixtures';
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

const GIFTS = '/v1/credit-package-gifts';
const ADMIN = '/v1/admin/credit-fulfillments';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface FulfillmentView {
  id: string;
  kind: string;
  status: string;
  holdReason: string | null;
  attempts: number;
  gift: { id: string; status: string } | null;
  events: Array<{ type: string; status: string; actor: string | null }>;
}

/**
 * Credit package gifts through the complete application and Stripe: the
 * sender invites, the recipient accepts or declines before any payment, the
 * sender pays an accepted gift, and the recipient receives GIFT credits once
 * at the delivery time, or an administrator reviews the gift when the
 * recipient cannot receive credits.
 */
describeWithDatabase(
  'Credit package gifts (PostgreSQL, full stack, Stripe)',
  () => {
    let app: ReferralApp;
    let p: ReturnType<typeof creditPackageFlows>;
    let admin: TestAccount;

    const worker = () =>
      app.ctx.get<CreditFulfillmentWorker>(CreditFulfillmentWorker);
    const giftAs = async (account: TestAccount, giftId: string) =>
      dataOf<GiftView>(await p.get(account, `${GIFTS}/${giftId}`).expect(200));
    const answer = (
      account: TestAccount,
      giftId: string,
      action: 'accept' | 'decline' | 'cancel',
    ) => p.post(account, `${GIFTS}/${giftId}/${action}`);
    const inbox = async (account: TestAccount) =>
      (await p.notificationsOf(account.id)).map((n) => n.type);
    /** A sender and a recipient, and an accepted gift between them. */
    const acceptedGift = async (body: Record<string, unknown> = {}) => {
      const sender = await p.signUp({ prefix: 'snd' });
      const recipient = await p.signUp({ prefix: 'rcp' });
      const gift = await p.sendGift(sender, recipient.email, body);
      await answer(recipient, gift.id, 'accept').expect(200);
      return { sender, recipient, gift };
    };

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
      await app.ctx.client.creditPackage.deleteMany();
      await app.ctx
        .get<CreditPackageSettingsService>(CreditPackageSettingsService)
        .ensureDefaults();
    });

    afterAll(async () => {
      await app?.ctx.close();
    });

    describe('invitation, acceptance and payment', () => {
      it('lets the recipient view and accept the invitation before the sender pays, then delivers GIFT credits once', async () => {
        const sender = await p.signUp({ prefix: 'snd' });
        const recipient = await p.signUp({ prefix: 'rcp' });
        const stranger = await p.signUp({ prefix: 'str' });

        const gift = await p.sendGift(sender, recipient.email, {
          packageCode: 'MEDIUM',
          message: 'Enjoy your looks!',
        });
        expect(gift).toMatchObject({
          role: 'sender',
          status: 'PENDING',
          packageCode: 'MEDIUM',
          credits: 500,
          listPriceUsdCents: 1000,
          message: 'Enjoy your looks!',
          recipient: { id: recipient.id },
          checkout: null,
        });
        expect(await inbox(recipient)).toEqual(['GIFT_RECEIVED']);

        // The recipient sees it (without the price); nobody else does.
        const received = dataOf<GiftView[]>(
          await p.get(recipient, `${GIFTS}?box=received`).expect(200),
        );
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          id: gift.id,
          role: 'recipient',
          status: 'PENDING',
          sender: { id: sender.id },
          credits: 500,
        });
        expect(received[0]).not.toHaveProperty('listPriceUsdCents');
        await p.get(stranger, `${GIFTS}/${gift.id}`).expect(404);
        expect(
          dataOf<GiftView[]>(await p.get(stranger, `${GIFTS}?box=received`)),
        ).toEqual([]);
        await answer(stranger, gift.id, 'accept').expect(404);

        // Not payable before it is accepted.
        expect(
          messageOf(await p.giftCheckoutRequest(sender, gift.id).expect(409)),
        ).toBe('The recipient has not accepted this gift yet');
        // Only the recipient accepts.
        await answer(sender, gift.id, 'accept').expect(404);
        await answer(recipient, gift.id, 'accept').expect(200);
        await answer(recipient, gift.id, 'accept').expect(409);
        expect(await inbox(sender)).toEqual(['GIFT_ACCEPTED']);
        // Only the sender pays.
        await p.giftCheckoutRequest(recipient, gift.id).expect(404);

        const { order } = await p.payGift(sender, gift.id);
        expect(order).toMatchObject({
          kind: 'GIFT',
          giftId: gift.id,
          credits: 500,
          amountDueUsdCents: 1000,
        });
        expect(await p.giftCredits(recipient.id)).toEqual([
          {
            reference: `credit-gift:${gift.id}`,
            amount: '500',
            expiresAt: null,
          },
        ]);
        // The sender pays but receives nothing.
        expect(await p.giftCredits(sender.id)).toEqual([]);
        expect(await p.packageCredits(sender.id)).toEqual([]);
        await expect(giftAs(recipient, gift.id)).resolves.toMatchObject({
          status: 'DELIVERED',
        });
        expect((await inbox(recipient)).sort()).toEqual([
          'GIFT_DELIVERED',
          'GIFT_RECEIVED',
        ]);
        expect((await inbox(sender)).sort()).toEqual([
          'GIFT_ACCEPTED',
          'GIFT_DELIVERED',
          'GIFT_PAID',
        ]);
        const balance = dataOf<{
          sources: Array<{ source: string; available: string }>;
        }>(await p.get(recipient, '/v1/credits/balance').expect(200));
        expect(
          balance.sources.find((s) => s.source === 'GIFT')?.available,
        ).toBe('500');
        // Gift credits open makeup sessions.
        await p.post(recipient, '/v1/sessions').expect(201);

        // Repeated payment events deliver nothing more.
        const sessionId = await p.sessionOf(order.id);
        await Promise.all([
          p.sessionEvent('checkout.session.completed', sessionId),
          p.sessionEvent('checkout.session.async_payment_succeeded', sessionId),
        ]);
        await worker().runOnce(new Date(Date.now() + DAY));
        expect(await p.giftCredits(recipient.id)).toHaveLength(1);
        await expectConsistentLedger(app.ctx.client, recipient.id);
      });

      it('delivers at the scheduled time, once, however often the worker runs', async () => {
        const deliverAt = new Date(Date.now() + 3 * HOUR);
        const { sender, recipient, gift } = await acceptedGift({
          deliverAt: deliverAt.toISOString(),
        });
        const { order } = await p.payGift(sender, gift.id);
        expect(order.status).toBe('OPEN');
        await expect(p.giftRow(gift.id)).resolves.toMatchObject({
          status: 'PAID',
        });
        expect(await p.giftCredits(recipient.id)).toEqual([]);
        await expect(p.fulfillmentOf(order.id)).resolves.toMatchObject({
          status: 'PENDING',
          dueAt: deliverAt,
        });

        // Before the delivery time: nothing.
        await worker().runOnce(new Date(deliverAt.getTime() - 60_000));
        expect(await p.giftCredits(recipient.id)).toEqual([]);

        // At the delivery time, with several concurrent runs.
        const later = new Date(deliverAt.getTime() + 60_000);
        await Promise.all([
          worker().runOnce(later),
          worker().runOnce(later),
          worker().runOnce(later),
        ]);
        await worker().runOnce(new Date(later.getTime() + DAY));
        expect(
          (await p.giftCredits(recipient.id)).map((c) => c.amount),
        ).toEqual(['250']);
        await expect(p.giftRow(gift.id)).resolves.toMatchObject({
          status: 'DELIVERED',
        });
        const fulfillment = await p.fulfillmentOf(order.id);
        expect(fulfillment.events.map((e) => e.type)).toEqual([
          'CREATED',
          'SUCCEEDED',
        ]);
      });
    });

    describe('gifts that never reach payment or credits', () => {
      it('refuses payment of declined and expired invitations', async () => {
        const sender = await p.signUp({ prefix: 'snd' });
        const recipient = await p.signUp({ prefix: 'rcp' });

        const declined = await p.sendGift(sender, recipient.email);
        await answer(recipient, declined.id, 'decline').expect(200);
        expect(await inbox(sender)).toEqual(['GIFT_DECLINED']);
        await answer(recipient, declined.id, 'accept').expect(409);
        expect(
          messageOf(
            await p.giftCheckoutRequest(sender, declined.id).expect(409),
          ),
        ).toMatch(/cannot be paid/);

        const lapsing = await p.sendGift(sender, recipient.email);
        const acceptedLapsing = await p.sendGift(sender, recipient.email);
        await answer(recipient, acceptedLapsing.id, 'accept').expect(200);
        // Eight days later: both invitations expired.
        const result = await worker().runOnce(new Date(Date.now() + 8 * DAY));
        expect(result.expiredGifts).toBeGreaterThanOrEqual(2);
        await expect(p.giftRow(lapsing.id)).resolves.toMatchObject({
          status: 'EXPIRED',
        });
        await answer(recipient, lapsing.id, 'accept').expect(409);
        await p.giftCheckoutRequest(sender, acceptedLapsing.id).expect(409);

        await expect(
          app.ctx.client.creditPackageOrder.count({
            where: { authId: sender.id },
          }),
        ).resolves.toBe(0);
        expect(await p.giftCredits(recipient.id)).toEqual([]);
      });

      it('grants nothing for canceled or unpaid gifts', async () => {
        // Canceled by the sender while its checkout was open.
        const { sender, recipient, gift } = await acceptedGift();
        const opened = dataOf<OrderView>(
          await p.giftCheckoutRequest(sender, gift.id).expect(201),
        );
        await answer(recipient, gift.id, 'cancel').expect(404);
        const canceled = dataOf<GiftView>(
          await answer(sender, gift.id, 'cancel').expect(200),
        );
        expect(canceled.status).toBe('CANCELED');
        await expect(p.orderRow(opened.id)).resolves.toMatchObject({
          status: 'CANCELED',
        });
        expect(
          app.stripe.api.sessions.get(await p.sessionOf(opened.id))?.status,
        ).toBe('expired');
        await p.giftCheckoutRequest(sender, gift.id).expect(409);

        // Unpaid: the checkout is abandoned; the gift stays payable.
        const other = await acceptedGift();
        const abandoned = dataOf<OrderView>(
          await p.giftCheckoutRequest(other.sender, other.gift.id).expect(201),
        );
        // A second request while it is open returns the same checkout.
        expect(
          dataOf<OrderView>(
            await p
              .giftCheckoutRequest(other.sender, other.gift.id)
              .expect(201),
          ).id,
        ).toBe(abandoned.id);
        const session = await p.sessionOf(abandoned.id);
        app.stripe.api.expireByTime(session);
        await p.sessionEvent('checkout.session.expired', session).expect(200);
        await expect(p.giftRow(other.gift.id)).resolves.toMatchObject({
          status: 'ACCEPTED',
        });
        expect(await p.giftCredits(other.recipient.id)).toEqual([]);
        // Paying later works, once.
        await p.payGift(other.sender, other.gift.id);
        expect(
          (await p.giftCredits(other.recipient.id)).map((c) => c.amount),
        ).toEqual(['250']);
        await answer(other.sender, other.gift.id, 'cancel').expect(409);
        await answer(other.recipient, other.gift.id, 'decline').expect(409);
        expect(await p.giftCredits(recipient.id)).toEqual([]);
      });
    });

    describe('recipients who cannot receive credits', () => {
      it('holds the paid gift for review when the recipient is unverified; an administrator delivers it', async () => {
        const { sender, recipient, gift } = await acceptedGift();
        await app.ctx.client.authUser.update({
          where: { id: recipient.id },
          data: { verified: false },
        });
        const { order } = await p.payGift(sender, gift.id);
        expect(await p.giftCredits(recipient.id)).toEqual([]);
        await expect(p.giftRow(gift.id)).resolves.toMatchObject({
          status: 'REVIEW',
          reviewReason: 'RECIPIENT_UNVERIFIED',
        });

        const held = dataOf<FulfillmentView[]>(
          await p.get(admin, `${ADMIN}?status=HELD&kind=GIFT`).expect(200),
        );
        const entry = held.find((f) => f.gift?.id === gift.id)!;
        expect(entry).toMatchObject({
          status: 'HELD',
          holdReason: 'RECIPIENT_UNVERIFIED',
          gift: { status: 'REVIEW' },
        });
        // Regular users cannot see or decide.
        await p.get(recipient, ADMIN).expect(403);
        await p.post(sender, `${ADMIN}/${entry.id}/approve`).expect(403);

        const approved = dataOf<FulfillmentView>(
          await p.post(admin, `${ADMIN}/${entry.id}/approve`).expect(200),
        );
        expect(approved.status).toBe('SUCCEEDED');
        expect(approved.events.map((e) => [e.type, e.actor])).toEqual([
          ['CREATED', null],
          ['HELD_FOR_REVIEW', null],
          ['APPROVED', admin.id],
        ]);
        expect(
          (await p.giftCredits(recipient.id)).map((c) => c.amount),
        ).toEqual(['250']);
        await expect(p.giftRow(gift.id)).resolves.toMatchObject({
          status: 'DELIVERED',
          reviewedBy: admin.id,
        });
        await p.post(admin, `${ADMIN}/${entry.id}/approve`).expect(409);
        await expect(p.fulfillmentOf(order.id)).resolves.toMatchObject({
          status: 'SUCCEEDED',
        });
      });

      it('holds gifts of inactive or pending-deletion recipients; a rejected gift is never delivered', async () => {
        const suspended = await acceptedGift();
        await app.ctx.client.authUser.update({
          where: { id: suspended.recipient.id },
          data: { status: 'SUSPENDED' },
        });
        const pending = await acceptedGift();
        await app.ctx.client.authUser.update({
          where: { id: pending.recipient.id },
          data: { status: 'PENDING_DELETION' },
        });
        const a = await p.payGift(suspended.sender, suspended.gift.id);
        const b = await p.payGift(pending.sender, pending.gift.id);
        const heldA = await p.fulfillmentOf(a.order.id);
        const heldB = await p.fulfillmentOf(b.order.id);
        expect([heldA.status, heldA.holdReason]).toEqual([
          'HELD',
          'RECIPIENT_INACTIVE',
        ]);
        expect([heldB.status, heldB.holdReason]).toEqual([
          'HELD',
          'RECIPIENT_INACTIVE',
        ]);

        // A recipient pending deletion can never receive it.
        expect(
          messageOf(
            await p.post(admin, `${ADMIN}/${heldB.id}/approve`).expect(409),
          ),
        ).toBe('The recipient can no longer receive credits');
        const rejected = dataOf<FulfillmentView>(
          await p.post(admin, `${ADMIN}/${heldB.id}/reject`).expect(200),
        );
        expect(rejected.status).toBe('REJECTED');
        await expect(p.giftRow(pending.gift.id)).resolves.toMatchObject({
          status: 'REJECTED',
        });
        await p.post(admin, `${ADMIN}/${heldB.id}/approve`).expect(409);
        // The worker never delivers held or rejected gifts.
        await worker().runOnce(new Date(Date.now() + 2 * DAY));
        expect(await p.giftCredits(suspended.recipient.id)).toEqual([]);
        expect(await p.giftCredits(pending.recipient.id)).toEqual([]);
      });
    });

    describe('eligibility and validation', () => {
      it('never changes the recipient’s first-purchase or referral eligibility; the payment is the sender’s purchase', async () => {
        await p.setDiscountSettings(admin, {
          firstPurchaseDiscountPercent: 20,
          referralDiscountPercent: 0,
          referrerRewardCredits: 40,
        });
        const senderReferrer = await p.signUp({ prefix: 'sref' });
        const recipientReferrer = await p.signUp({ prefix: 'rref' });
        const sender: SignedUp = await p.signUp({
          prefix: 'snd',
          referralCode: await p.codeOf(senderReferrer),
        });
        const recipient: SignedUp = await p.signUp({
          prefix: 'rcp',
          referralCode: await p.codeOf(recipientReferrer),
        });
        const gift = await p.sendGift(sender, recipient.email);
        await answer(recipient, gift.id, 'accept').expect(200);
        const { order } = await p.payGift(sender, gift.id);
        // The sender's first purchase: their discount and their referrer.
        expect(order).toMatchObject({
          discount: { source: 'FIRST_PURCHASE', percent: 20 },
          amountDueUsdCents: 400,
        });
        await expect(p.referralOf(sender.id)).resolves.toMatchObject({
          status: 'REWARDED',
          qualifyingPackageOrderId: order.id,
        });
        expect(await p.giftCredits(recipient.id)).toHaveLength(1);

        // The recipient keeps both.
        await expect(p.referralOf(recipient.id)).resolves.toMatchObject({
          status: 'PENDING',
        });
        expect(await p.rewardAllocations(recipientReferrer.id)).toEqual([]);
        expect(
          (await p.orderPackage(recipient, 'SMALL')).discount,
        ).toMatchObject({ source: 'FIRST_PURCHASE' });
        expect((await p.orderPackage(sender, 'SMALL')).discount).toBeNull();
      });

      it('validates invitations and returns the same gift for a repeated request', async () => {
        const sender = await p.signUp({ prefix: 'val' });
        const recipient = await p.signUp({ prefix: 'valr' });
        const send = (body: Record<string, unknown>, key?: string | null) =>
          p.sendGiftRequest(
            sender,
            { packageCode: 'SMALL', recipient: recipient.email, ...body },
            key,
          );
        expect(
          messageOf(await send({ recipient: sender.email }).expect(400)),
        ).toBe('You cannot send a gift to yourself');
        await send({ recipient: 'nobody@example.com' }).expect(404);
        await send({ packageCode: 'HUGE' }).expect(400);
        await send({
          deliverAt: new Date(Date.now() - HOUR).toISOString(),
        }).expect(400);
        await send({
          deliverAt: new Date(Date.now() + 400 * DAY).toISOString(),
        }).expect(400);
        await send({ message: 'x'.repeat(281) }).expect(400);
        await send({ extra: true }).expect(400);
        await send({}, null).expect(400);
        await p
          .http()
          .post(GIFTS)
          .send({ packageCode: 'SMALL', recipient: recipient.email })
          .expect(401);

        const key = p.newKey();
        const first = dataOf<GiftView>(await send({}, key).expect(201));
        const responses = await Promise.all([send({}, key), send({}, key)]);
        expect(responses.map((res) => dataOf<GiftView>(res).id)).toEqual([
          first.id,
          first.id,
        ]);
        await send({ packageCode: 'LARGE' }, key).expect(409);
        await expect(
          app.ctx.client.creditGift.count({
            where: { senderAuthId: sender.id },
          }),
        ).resolves.toBe(1);
        // Users see only their own gifts.
        const other = await createAccount(app.ctx);
        expect(
          dataOf<GiftView[]>(await p.get(other, GIFTS).expect(200)),
        ).toEqual([]);
      });

      it('has PostgreSQL refuse gifts with other terms, gift credits without a paid gift and backward status changes', async () => {
        const { sender, recipient, gift } = await acceptedGift();
        await expect(
          app.ctx.client.creditGift.create({
            data: {
              senderAuthId: sender.id,
              recipientAuthId: recipient.id,
              idempotencyKey: 'manual',
              packageCode: 'SMALL',
              credits: 9999,
              listPriceUsdCents: 500,
              deliverAt: new Date(),
              expiresAt: new Date(Date.now() + DAY),
            },
          }),
        ).rejects.toThrow('current terms of an available package');
        await expect(
          app.ctx.client.creditGift.update({
            where: { id: gift.id },
            data: { status: 'PENDING', acceptedAt: null },
          }),
        ).rejects.toThrow();
        await expect(
          app.ctx.client.creditGift.update({
            where: { id: gift.id },
            data: { credits: 5000 },
          }),
        ).rejects.toThrow('The terms of a gift cannot change');
        const wallet = await app.ctx.client.creditWallet.upsert({
          where: { authId: recipient.id },
          create: { authId: recipient.id },
          update: {},
        });
        await expect(
          app.ctx.client.creditAllocation.create({
            data: {
              walletId: wallet.id,
              authId: recipient.id,
              source: 'GIFT',
              sourceReference: `credit-gift:${gift.id}`,
              amount: 250,
              remaining: 250,
              grantedAt: new Date(),
            },
          }),
        ).rejects.toThrow('Gift credits require a paid gift');
      });
    });
  },
);
