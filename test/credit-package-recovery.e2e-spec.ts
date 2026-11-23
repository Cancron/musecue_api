// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { CreditPackageSettingsService } from '../src/credit-packages/credit-package-settings.service';
import { CreditFulfillmentService } from '../src/credit-packages/fulfillment/credit-fulfillment.service';
import { CreditFulfillmentWorker } from '../src/credit-packages/fulfillment/credit-fulfillment.worker';
import { CreditWalletService } from '../src/credits/credit-wallet.service';
import { expectConsistentLedger } from './support/credit-fixtures';
import { creditPackageFlows } from './support/credit-package-flows';
import type { TestAccount } from './support/discount-fixtures';
import { FakeStripeApi } from './support/fake-stripe-api';
import {
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';
import {
  bootReferralApp,
  dataOf,
  type ReferralApp,
} from './support/referral-flows';

jest.setTimeout(300_000);

const ADMIN = '/v1/admin/credit-fulfillments';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface FulfillmentView {
  id: string;
  status: string;
  attempts: number;
  lastErrorCode: string | null;
  order: { id: string; status: string };
  events: Array<{ type: string; status: string; actor: string | null }>;
}

/**
 * Recovery of paid credit package orders and gifts through the complete
 * application, real restarts on the same PostgreSQL schema and several
 * application instances at once: a crash between the verified payment and
 * the grant, failed grants, lost payment events, duplicate workers and
 * duplicate or out-of-order events never lose a paid order and never grant
 * twice; administrators see failures and their audit records.
 */
describeWithDatabase(
  'Credit package recovery (PostgreSQL, full stack, restarts)',
  () => {
    let schema: string;
    let app: ReferralApp;
    let p: ReturnType<typeof creditPackageFlows>;
    let admin: TestAccount;
    let stripeApi: FakeStripeApi;
    const extraApps: ReferralApp[] = [];
    const previousWorkerSetting = process.env.CREDIT_FULFILLMENT_WORKER_ENABLED;

    /** Boots another instance on the same schema and Stripe fake. */
    const boot = async () => {
      const next = await bootReferralApp(schema);
      next.stripe.api = stripeApi;
      return next;
    };
    const use = (next: ReferralApp) => {
      app = next;
      p = creditPackageFlows(app);
    };
    const worker = (target: ReferralApp = app) =>
      target.ctx.get<CreditFulfillmentWorker>(CreditFulfillmentWorker);
    const fulfillments = () =>
      app.ctx.get<CreditFulfillmentService>(CreditFulfillmentService);

    beforeAll(async () => {
      schema = await createSchema();
      await applyMigrations(schema, migrationNames());
      stripeApi = new FakeStripeApi(5);
      use(await boot());
      admin = await p.admin();
    });

    beforeEach(async () => {
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

    afterEach(() => {
      jest.restoreAllMocks();
      if (previousWorkerSetting === undefined) {
        delete process.env.CREDIT_FULFILLMENT_WORKER_ENABLED;
      } else {
        process.env.CREDIT_FULFILLMENT_WORKER_ENABLED = previousWorkerSetting;
      }
    });

    afterAll(async () => {
      for (const extra of extraApps) await extra.ctx.close();
      await app?.ctx.close();
      if (schema) await dropSchema(schema);
    });

    it('grants the credits of an order paid just before a crash after a restart, once, with duplicate workers', async () => {
      const user = await p.signUp({ prefix: 'crash' });
      const order = await p.orderPackage(user, 'MEDIUM');
      const sessionId = await p.payOrder(order.id);

      // The process stops after the payment was recorded, before the grant.
      const grant = jest
        .spyOn(fulfillments(), 'processOne')
        .mockResolvedValue('SKIPPED');
      await p.sessionEvent('checkout.session.completed', sessionId).expect(200);
      // Stripe retries the event meanwhile: still nothing granted twice.
      await Promise.all([
        p.sessionEvent('checkout.session.completed', sessionId),
        p.sessionEvent('checkout.session.async_payment_succeeded', sessionId),
      ]);
      grant.mockRestore();
      await expect(p.orderRow(order.id)).resolves.toMatchObject({
        status: 'PAID',
      });
      await expect(p.fulfillmentOf(order.id)).resolves.toMatchObject({
        status: 'PENDING',
        attempts: 0,
      });
      expect(await p.packageCredits(user.id)).toEqual([]);
      await app.ctx.close();

      // Two instances start at once, each running the recovery worker.
      process.env.CREDIT_FULFILLMENT_WORKER_ENABLED = 'true';
      const [first, second] = await Promise.all([boot(), boot()]);
      extraApps.push(second);
      use(first);
      await Promise.all([
        worker(first).runOnce(),
        worker(second).runOnce(),
        worker(first).runOnce(),
      ]);
      // A late duplicate of the payment event changes nothing either.
      await p.sessionEvent('checkout.session.completed', sessionId).expect(200);
      // (Background jobs such as emails go to any instance: stop the second.)
      await second.ctx.close();
      extraApps.splice(extraApps.indexOf(second), 1);

      expect((await p.packageCredits(user.id)).map((c) => c.amount)).toEqual([
        '500',
      ]);
      const fulfillment = await p.fulfillmentOf(order.id);
      expect(fulfillment.status).toBe('SUCCEEDED');
      expect(fulfillment.events.map((e) => e.type)).toEqual([
        'CREATED',
        'SUCCEEDED',
      ]);
      await expectConsistentLedger(app.ctx.client, user.id);
    });

    it('retries failed grants with backoff, records every attempt, and lets an administrator retry exhausted ones', async () => {
      const user = await p.signUp({ prefix: 'retry' });
      const wallet = app.ctx.get<CreditWalletService>(CreditWalletService);
      const failing = jest
        .spyOn(wallet, 'grant')
        .mockRejectedValue(new Error('ledger unavailable'));

      const { order } = await p.buyPackage(user, 'SMALL');
      const start = Date.now();
      let fulfillment = await p.fulfillmentOf(order.id);
      expect(fulfillment).toMatchObject({
        status: 'RETRYING',
        attempts: 1,
        lastErrorCode: 'Error',
      });
      // Not before its backoff.
      await worker().runOnce(new Date(start + 5_000));
      expect((await p.fulfillmentOf(order.id)).attempts).toBe(1);
      // Further failed attempts until it gives up.
      for (let hours = 1; hours <= 6; hours += 1) {
        await worker().runOnce(new Date(start + hours * HOUR));
      }
      fulfillment = await p.fulfillmentOf(order.id);
      expect(fulfillment).toMatchObject({ status: 'FAILED', attempts: 5 });
      expect(fulfillment.events.map((e) => [e.type, e.status])).toEqual([
        ['CREATED', 'PENDING'],
        ['ATTEMPT_FAILED', 'RETRYING'],
        ['ATTEMPT_FAILED', 'RETRYING'],
        ['ATTEMPT_FAILED', 'RETRYING'],
        ['ATTEMPT_FAILED', 'RETRYING'],
        ['ATTEMPT_FAILED', 'FAILED'],
      ]);
      // A failed fulfillment is not retried automatically.
      await worker().runOnce(new Date(start + 2 * DAY));
      expect((await p.fulfillmentOf(order.id)).attempts).toBe(5);
      expect(await p.packageCredits(user.id)).toEqual([]);

      // Administrators see the failure and its audit records.
      const failed = dataOf<FulfillmentView[]>(
        await p.get(admin, `${ADMIN}?status=FAILED`).expect(200),
      );
      expect(failed.find((f) => f.order.id === order.id)).toMatchObject({
        status: 'FAILED',
        attempts: 5,
        lastErrorCode: 'Error',
        order: { status: 'PAID' },
      });
      await p.get(user, `${ADMIN}?status=FAILED`).expect(403);
      await p.http().get(ADMIN).expect(401);
      await p.get(admin, `${ADMIN}?status=BROKEN`).expect(400);

      failing.mockRestore();
      const retried = dataOf<FulfillmentView>(
        await p.post(admin, `${ADMIN}/${fulfillment.id}/retry`).expect(200),
      );
      expect(retried.status).toBe('SUCCEEDED');
      expect(retried.events.slice(-2).map((e) => [e.type, e.actor])).toEqual([
        ['RETRY_REQUESTED', admin.id],
        ['SUCCEEDED', null],
      ]);
      await p.post(admin, `${ADMIN}/${fulfillment.id}/retry`).expect(409);
      expect((await p.packageCredits(user.id)).map((c) => c.amount)).toEqual([
        '250',
      ]);
      await expect(
        app.ctx.client.activityLogEvent.count({
          where: { tableName: 'CreditFulfillment', recordId: fulfillment.id },
        }),
      ).resolves.toBe(1);
      await expectConsistentLedger(app.ctx.client, user.id);
    });

    it('recovers orders whose payment events never arrived, and ignores late, duplicate or out-of-order events', async () => {
      await p.setDiscountSettings(admin, {
        firstPurchaseDiscountPercent: 10,
        referralDiscountPercent: 0,
        referrerRewardCredits: 0,
      });
      const buyer = await p.signUp({ prefix: 'lost' });
      const paid = await p.orderPackage(buyer, 'SMALL');
      const sessionId = await p.payOrder(paid.id);
      const start = Date.now();

      // Too recent to reconcile: the webhook may still arrive.
      await worker().runOnce(new Date(start + 5 * MINUTE));
      expect(await p.packageCredits(buyer.id)).toEqual([]);
      const result = await worker().runOnce(new Date(start + 11 * MINUTE));
      expect(result.reconciledOrders).toBeGreaterThanOrEqual(1);
      await expect(p.orderRow(paid.id)).resolves.toMatchObject({
        status: 'PAID',
      });
      expect((await p.packageCredits(buyer.id)).map((c) => c.amount)).toEqual([
        '250',
      ]);
      // The events arrive late, duplicated and out of order.
      await Promise.all([
        p.sessionEvent('checkout.session.expired', sessionId),
        p.sessionEvent('checkout.session.async_payment_succeeded', sessionId),
        p.sessionEvent('checkout.session.completed', sessionId),
        p.sessionEvent('checkout.session.completed', sessionId),
      ]);
      await expect(p.orderRow(paid.id)).resolves.toMatchObject({
        status: 'PAID',
      });
      expect(await p.packageCredits(buyer.id)).toHaveLength(1);

      // Abandoned without an expiry event: closed, discount given back.
      const other = await p.signUp({ prefix: 'aband' });
      const abandoned = await p.orderPackage(other, 'SMALL');
      expect(abandoned.discount).toMatchObject({ source: 'FIRST_PURCHASE' });
      stripeApi.expireByTime(await p.sessionOf(abandoned.id));
      await worker().runOnce(new Date(Date.now() + 11 * MINUTE));
      await expect(p.orderRow(abandoned.id)).resolves.toMatchObject({
        status: 'EXPIRED',
        closedReason: 'PROVIDER_EXPIRED',
      });
      await expect(
        app.ctx.client.discountRedemption.findFirstOrThrow({
          where: { packageOrderId: abandoned.id },
        }),
      ).resolves.toMatchObject({ status: 'RELEASED' });
      expect(await p.packageCredits(other.id)).toEqual([]);
    });

    it('delivers a paid gift scheduled across a restart once, with one notification', async () => {
      const sender = await p.signUp({ prefix: 'gsnd' });
      const recipient = await p.signUp({ prefix: 'grcp' });
      const deliverAt = new Date(Date.now() + 2 * HOUR);
      const gift = await p.sendGift(sender, recipient.email, {
        deliverAt: deliverAt.toISOString(),
      });
      await p
        .post(recipient, `/v1/credit-package-gifts/${gift.id}/accept`)
        .expect(200);
      const { order } = await p.payGift(sender, gift.id);
      await expect(p.fulfillmentOf(order.id)).resolves.toMatchObject({
        status: 'PENDING',
      });
      await app.ctx.close();

      // After the restart (before the delivery time) nothing is delivered.
      process.env.CREDIT_FULFILLMENT_WORKER_ENABLED = 'true';
      use(await boot());
      expect(await p.giftCredits(recipient.id)).toEqual([]);
      const due = new Date(deliverAt.getTime() + MINUTE);
      const second = await boot();
      extraApps.push(second);
      await Promise.all([worker().runOnce(due), worker(second).runOnce(due)]);
      await worker().runOnce(new Date(due.getTime() + DAY));
      await second.ctx.close();
      extraApps.splice(extraApps.indexOf(second), 1);

      expect((await p.giftCredits(recipient.id)).map((c) => c.amount)).toEqual([
        '250',
      ]);
      await expect(p.giftRow(gift.id)).resolves.toMatchObject({
        status: 'DELIVERED',
      });
      expect(
        (await p.notificationsOf(recipient.id)).filter(
          (n) => n.type === 'GIFT_DELIVERED',
        ),
      ).toHaveLength(1);
    });

    it('has PostgreSQL refuse succeeded fulfillments without credits and changes to audit records', async () => {
      const user = await p.signUp({ prefix: 'guard' });
      const grant = jest
        .spyOn(fulfillments(), 'processOne')
        .mockResolvedValue('SKIPPED');
      const { order } = await p.buyPackage(user, 'SMALL');
      grant.mockRestore();
      const fulfillment = await p.fulfillmentOf(order.id);
      await expect(
        app.ctx.client.creditFulfillment.update({
          where: { id: fulfillment.id },
          data: { status: 'SUCCEEDED', completedAt: new Date() },
        }),
      ).rejects.toThrow(
        'A succeeded fulfillment must have granted its credits',
      );
      await expect(
        app.ctx.client.creditFulfillment.update({
          where: { id: fulfillment.id },
          data: { credits: 9999 },
        }),
      ).rejects.toThrow('A fulfillment cannot be changed');
      await expect(
        app.ctx.client.creditFulfillmentEvent.deleteMany({
          where: { fulfillmentId: fulfillment.id },
        }),
      ).rejects.toThrow('Fulfillment audit records cannot be changed');
      await expect(
        app.ctx.client.creditFulfillment.delete({
          where: { id: fulfillment.id },
        }),
      ).rejects.toThrow('Credit fulfillments cannot be deleted');
      // The worker completes it.
      await worker().runOnce();
      expect((await p.packageCredits(user.id)).map((c) => c.amount)).toEqual([
        '250',
      ]);
    });
  },
);
