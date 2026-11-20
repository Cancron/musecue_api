// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import request from 'supertest';
import { totpCode } from '../src/auth/mfa/mfa-totp';
import { FakeStripeApi } from './support/fake-stripe-api';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  type TestApplication,
} from './support/infrastructure-flows';
import {
  dataOf,
  messageOf,
  MfaTestKit,
  MIN,
  PASSWORD,
  SECOND,
  type TestUser,
  wrongCode,
} from './support/mfa-e2e';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(120_000);

const DAY = 24 * 60 * MIN;
const HEADER = 'X-Step-Up-Token';
const CANCEL = '/v1/subscription/cancel';

interface CancellationView {
  status: string;
  hasProAccess: boolean;
  autoRenew: boolean;
  canceledAt: string;
  endsAt: string;
  accessExpiresAt: string;
  alreadyCanceled: boolean;
}

interface Subscriber {
  user: TestUser;
  recoveryCodes: string[];
  /** The Stripe subscription (`sub_...`). */
  subscriptionId: string;
}

/**
 * MFA step-up for subscription cancellation, through the real endpoints of
 * the whole application on a temporary, freshly migrated PostgreSQL schema,
 * with Stripe's servers replaced by FakeStripeApi (behind the real Stripe
 * SDK) and emails captured: no external service is used.
 *
 * Users with MFA enabled buy Pro through checkout and Stripe's signed
 * webhooks. POST /v1/subscription/cancel needs a step-up approval proven
 * with the authenticator or a recovery code: without one it answers 403 and
 * changes nothing (UserSubscription.proCanceledAt stays null, proExpiresAt
 * untouched, no CANCELED event, no Stripe request); with one it answers 200,
 * sets proCanceledAt, keeps proExpiresAt and records exactly one CANCELED
 * event. Stripe's cancellation webhooks never need a step-up.
 */
describeWithDatabase('MFA step-up for subscription cancellation (e2e)', () => {
  const stripe = { api: new FakeStripeApi() };
  let ctx: TestApplication;
  let kit: MfaTestKit;

  beforeAll(async () => {
    ctx = await bootApplication({ stripe });
    kit = new MfaTestKit(ctx, '198.29');
    freezeTime(kit.clock);
    kit.nextStepStart();
  });

  afterAll(async () => {
    jest.useRealTimers();
    await ctx?.close();
  });

  // Far apart, so sign-in rate limits and tokens of other tests never
  // matter; a fresh Stripe for every test.
  beforeEach(() => {
    kit.nextStepStart(60 * MIN);
    stripe.api = new FakeStripeApi();
  });

  const http = () => kit.http();

  /** A signed Stripe webhook delivery (no bearer token, no step-up). */
  const webhook = (event: { payload: string; signature: string }) =>
    http()
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', event.signature)
      .send(event.payload);

  /** A fresh authenticator code (the next 30-second step, never used). */
  const freshCode = (user: TestUser) => {
    kit.nextStepStart();
    return totpCode(user.totpSecret as string, kit.clock);
  };

  /** POST /auth/step-up (raw response). */
  const stepUp = (user: TestUser, body: Record<string, unknown>) =>
    http().post('/auth/step-up').set(kit.as(user)).send(body);

  /** An approval of `action` proven with the authenticator. */
  const mfaApproval = async (user: TestUser, action = 'SUBSCRIPTION_CANCEL') =>
    dataOf<{ stepUpToken: string; method: string }>(
      await stepUp(user, { action, code: freshCode(user) }).expect(201),
    );

  /** POST /v1/subscription/cancel as `user` with `headers`. */
  const cancel = (user: TestUser, headers: Record<string, string> = {}) =>
    http().post(CANCEL).set(kit.as(user)).set(headers);

  /**
   * A user with MFA enabled (through the API) who bought Pro 10 days ago:
   * checkout, payment on Stripe's page, signed webhook.
   */
  async function mfaSubscriber(
    before?: (user: TestUser) => Promise<void>,
  ): Promise<Subscriber> {
    const user = await kit.createUser();
    await before?.(user);
    const { recoveryCodes } = await kit.enableMfa(user);
    const checkout = dataOf<{ checkoutSessionId: string }>(
      await http()
        .post('/v1/subscription/checkout')
        .set(kit.as(user))
        .send({ billingInterval: 'MONTHLY' })
        .expect(201),
    );
    const { providerSessionId } =
      await ctx.client.checkoutSession.findUniqueOrThrow({
        where: { id: checkout.checkoutSessionId },
      });
    const session = stripe.api.completeSession(providerSessionId as string, {
      periodStart: new Date(kit.clock.getTime() - 10 * DAY),
    });
    await webhook(
      stripe.api.signedEvent(
        'checkout.session.completed',
        providerSessionId as string,
      ),
    ).expect(200);
    const record = await recordOf(user);
    expect(record).toMatchObject({ status: 'PRO', proCanceledAt: null });
    return {
      user,
      recoveryCodes,
      subscriptionId: session.subscription as string,
    };
  }

  const recordOf = (user: TestUser) =>
    ctx.client.userSubscription.findUniqueOrThrow({
      where: { authId: user.id },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });

  const canceledEvents = async (user: TestUser) =>
    (await recordOf(user)).events.filter((e) => e.type === 'CANCELED');

  /** Stripe requests that could change the subscription. */
  const stripeUpdates = () =>
    stripe.api.count('POST', /^\/v1\/subscriptions\//);

  /** Everything a cancellation changes, to prove nothing changed. */
  async function stateOf(subscriber: Subscriber) {
    const record = await recordOf(subscriber.user);
    return {
      record,
      stripe: {
        cancelAtPeriodEnd: stripe.api.subscriptions.get(
          subscriber.subscriptionId,
        )?.cancel_at_period_end,
        updates: stripeUpdates(),
      },
      auditEntries: await ctx.client.activityLogEvent.count({
        where: { tableName: 'UserSubscription', recordId: record.id },
      }),
    };
  }

  /** The refused request changed nothing at all. */
  async function expectUnchanged(
    subscriber: Subscriber,
    before: Awaited<ReturnType<typeof stateOf>>,
  ) {
    const after = await stateOf(subscriber);
    expect(after).toEqual(before);
    expect(after.record.proCanceledAt).toBeNull();
    expect(after.record.proExpiresAt).toEqual(before.record.proExpiresAt);
    expect(after.record.events.map((e) => e.type)).toEqual(['CREATED']);
    expect(after.stripe.cancelAtPeriodEnd).toBe(false);
  }

  describe('without a valid MFA step-up', () => {
    const variants: Record<
      string,
      (
        s: Subscriber,
        preMfaApproval?: string,
      ) => Promise<{ caller: TestUser; token?: string }>
    > = {
      'no approval': (s) => Promise.resolve({ caller: s.user }),
      'a malformed approval': (s) =>
        Promise.resolve({ caller: s.user, token: 'stup_not-a-token' }),
      'an approval of another action (DATA_EXPORT)': async (s) => ({
        caller: s.user,
        token: (await mfaApproval(s.user, 'DATA_EXPORT')).stepUpToken,
      }),
      'an expired approval (ten minutes old)': async (s) => {
        const token = (await mfaApproval(s.user)).stepUpToken;
        kit.advance(10 * MIN);
        return { caller: s.user, token };
      },
      'an approval of another session of the same user': async (s) => {
        const token = (await mfaApproval(s.user)).stepUpToken;
        const other = { ...s.user };
        await kit.signIn(other); // a second MFA sign-in
        return { caller: other, token };
      },
      'an approval of another user': async (s) => {
        const mallory = await kit.createUser();
        await kit.enableMfa(mallory);
        return {
          caller: s.user,
          token: (await mfaApproval(mallory)).stepUpToken,
        };
      },
      'an approval given with the password before MFA was enabled': (
        s,
        preMfaApproval,
      ) => Promise.resolve({ caller: s.user, token: preMfaApproval }),
      'a session opened through a trusted device': async (s) => {
        const { challengeToken } = dataOf<{ challengeToken: string }>(
          await kit.login(s.user).expect(201),
        );
        const trusted = dataOf<{ trustedDevice: { token: string } }>(
          await http()
            .post('/auth/login/mfa')
            .set('X-Forwarded-For', s.user.ip)
            .send({
              challengeToken,
              code: freshCode(s.user),
              trustDevice: true,
            })
            .expect(200),
        );
        const device = {
          ...s.user,
          trustedDeviceToken: trusted.trustedDevice.token,
        };
        const skipped = dataOf<{ mfaRequired: boolean; accessToken: string }>(
          await kit.login(device).expect(201),
        );
        expect(skipped.mfaRequired).toBe(false);
        // The trusted device skipped MFA at sign-in, never the step-up.
        return {
          caller: { ...device, accessToken: skipped.accessToken },
          token: undefined,
        };
      },
    };

    it.each(Object.keys(variants))(
      'with %s: 403, and proCanceledAt, proExpiresAt, events and Stripe unchanged',
      async (variant) => {
        let preMfaApproval: string | undefined;
        const subscriber = await mfaSubscriber(async (user) => {
          // Valid when given (no MFA yet), in the session that then
          // enables MFA.
          preMfaApproval = await kit.approve(user, 'SUBSCRIPTION_CANCEL', {
            password: PASSWORD,
          });
        });
        const { caller, token } = await variants[variant](
          subscriber,
          preMfaApproval,
        );
        const before = await stateOf(subscriber);

        const refused = await cancel(
          caller,
          token === undefined ? {} : { [HEADER]: token },
        ).expect(403);

        expect(messageOf(refused)).toMatch(/step-up/i);
        await expectUnchanged(subscriber, before);
      },
    );

    it('an MFA user cannot step up with the password', async () => {
      const subscriber = await mfaSubscriber();
      const before = await stateOf(subscriber);

      await stepUp(subscriber.user, {
        action: 'SUBSCRIPTION_CANCEL',
        password: PASSWORD,
      }).expect(400);
      const wrong = await stepUp(subscriber.user, {
        action: 'SUBSCRIPTION_CANCEL',
        code: wrongCode(freshCode(subscriber.user)),
      }).expect(400);
      expect(messageOf(wrong)).toMatch(/^Invalid MFA code\./);

      expect(
        await ctx.client.stepUpApproval.count({
          where: { authId: subscriber.user.id, action: 'SUBSCRIPTION_CANCEL' },
        }),
      ).toBe(0);
      await cancel(subscriber.user).expect(403);
      await expectUnchanged(subscriber, before);
    });

    it('a request without a valid access token is refused before the step-up (401)', async () => {
      const subscriber = await mfaSubscriber();
      const { stepUpToken } = await mfaApproval(subscriber.user);
      const before = await stateOf(subscriber);

      await http().post(CANCEL).set(HEADER, stepUpToken).expect(401);
      // Signed out: the session and its approval end together.
      await http()
        .post('/auth/sessions/revoke-all')
        .set(kit.as(subscriber.user))
        .expect(200);
      await cancel(subscriber.user, { [HEADER]: stepUpToken }).expect(401);

      await expectUnchanged(subscriber, before);
    });
  });

  describe('with a valid MFA step-up', () => {
    it('cancels at period end: 200, proCanceledAt set, proExpiresAt kept, exactly one CANCELED event', async () => {
      const subscriber = await mfaSubscriber();
      const before = await recordOf(subscriber.user);
      const approval = await mfaApproval(subscriber.user);
      expect(approval.method).toBe('TOTP');

      const response = await cancel(subscriber.user, {
        [HEADER]: approval.stepUpToken,
      }).expect(200);

      const inStripe = stripe.api.subscriptions.get(subscriber.subscriptionId);
      expect(inStripe).toMatchObject({
        status: 'active',
        cancel_at_period_end: true,
      });
      const canceledAt = new Date(Number(inStripe?.canceled_at) * 1000);
      expect(dataOf<CancellationView>(response)).toEqual({
        status: 'PRO',
        hasProAccess: true,
        autoRenew: false,
        canceledAt: canceledAt.toISOString(),
        endsAt: (before.proExpiresAt as Date).toISOString(),
        accessExpiresAt: (before.proExpiresAt as Date).toISOString(),
        alreadyCanceled: false,
      });
      const after = await recordOf(subscriber.user);
      expect(after).toMatchObject({
        status: 'PRO',
        proCanceledAt: canceledAt,
        proExpiresAt: before.proExpiresAt,
        proStartedAt: before.proStartedAt,
      });
      expect(after.events.map((e) => [e.type, e.occurredAt])).toEqual([
        ['CREATED', expect.any(Date)],
        ['CANCELED', canceledAt],
      ]);
      expect(stripeUpdates()).toBe(1);

      // The same approval repeats the same cancellation (idempotent), and
      // Stripe's webhook about it adds nothing.
      const again = await cancel(subscriber.user, {
        [HEADER]: approval.stepUpToken,
      }).expect(200);
      expect(dataOf<CancellationView>(again)).toMatchObject({
        alreadyCanceled: true,
        canceledAt: canceledAt.toISOString(),
      });
      await webhook(
        stripe.api.signedSubscriptionEvent(
          'customer.subscription.updated',
          subscriber.subscriptionId,
        ),
      ).expect(200);
      expect(await canceledEvents(subscriber.user)).toHaveLength(1);
      expect(await recordOf(subscriber.user)).toMatchObject({
        proCanceledAt: canceledAt,
        proExpiresAt: before.proExpiresAt,
      });
      // Pro access continues until the paid period ends.
      expect(
        dataOf<{ hasProAccess: boolean }>(
          await http().get('/v1/subscription').set(kit.as(subscriber.user)),
        ).hasProAccess,
      ).toBe(true);
    });

    it('a recovery code is an MFA step-up too', async () => {
      const subscriber = await mfaSubscriber();
      const before = await recordOf(subscriber.user);
      const approval = dataOf<{ stepUpToken: string; method: string }>(
        await stepUp(subscriber.user, {
          action: 'SUBSCRIPTION_CANCEL',
          recoveryCode: subscriber.recoveryCodes[0],
        }).expect(201),
      );
      expect(approval.method).toBe('RECOVERY_CODE');

      await cancel(subscriber.user, { [HEADER]: approval.stepUpToken }).expect(
        200,
      );

      const after = await recordOf(subscriber.user);
      expect(after.proCanceledAt).not.toBeNull();
      expect(after.proExpiresAt).toEqual(before.proExpiresAt);
      expect(await canceledEvents(subscriber.user)).toHaveLength(1);
    });

    it('concurrent cancellations with the approval record one CANCELED event', async () => {
      const subscriber = await mfaSubscriber();
      const { stepUpToken } = await mfaApproval(subscriber.user);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          cancel(subscriber.user, { [HEADER]: stepUpToken }).then((r) => r),
        ),
      );

      expect(responses.map((r) => r.status)).toEqual(Array(5).fill(200));
      expect(
        responses.filter((r) => !dataOf<CancellationView>(r).alreadyCanceled),
      ).toHaveLength(1);
      expect(await canceledEvents(subscriber.user)).toHaveLength(1);
    });

    it('a session opened through a trusted device can cancel after an MFA step-up', async () => {
      const subscriber = await mfaSubscriber();
      const { challengeToken } = dataOf<{ challengeToken: string }>(
        await kit.login(subscriber.user).expect(201),
      );
      const trusted = dataOf<{ trustedDevice: { token: string } }>(
        await http()
          .post('/auth/login/mfa')
          .set('X-Forwarded-For', subscriber.user.ip)
          .send({
            challengeToken,
            code: freshCode(subscriber.user),
            trustDevice: true,
          })
          .expect(200),
      );
      kit.advance(SECOND);
      const device: TestUser = {
        ...subscriber.user,
        trustedDeviceToken: trusted.trustedDevice.token,
      };
      device.accessToken = dataOf<{ accessToken: string }>(
        await kit.login(device).expect(201),
      ).accessToken;

      const { stepUpToken } = await mfaApproval(device);
      await cancel(device, { [HEADER]: stepUpToken }).expect(200);

      expect(await canceledEvents(subscriber.user)).toHaveLength(1);
    });
  });

  describe('Stripe webhooks do not need a step-up', () => {
    it('a cancellation made in Stripe (e.g. the customer portal) is recorded from its webhook', async () => {
      const subscriber = await mfaSubscriber();
      const before = await recordOf(subscriber.user);
      // No approval exists for this user's cancellation.
      expect(
        await ctx.client.stepUpApproval.count({
          where: { authId: subscriber.user.id, action: 'SUBSCRIPTION_CANCEL' },
        }),
      ).toBe(0);

      await stripe.api
        .client()
        .subscriptions.update(subscriber.subscriptionId, {
          cancel_at_period_end: true,
        });
      const updated = stripe.api.signedSubscriptionEvent(
        'customer.subscription.updated',
        subscriber.subscriptionId,
      );
      await webhook(updated).expect(200);
      await webhook(updated).expect(200); // redelivered

      const canceledAt = new Date(
        Number(
          stripe.api.subscriptions.get(subscriber.subscriptionId)?.canceled_at,
        ) * 1000,
      );
      const after = await recordOf(subscriber.user);
      expect(after).toMatchObject({
        proCanceledAt: canceledAt,
        proExpiresAt: before.proExpiresAt,
      });
      expect(await canceledEvents(subscriber.user)).toHaveLength(1);

      // The user's own request later (with an MFA step-up) finds it done.
      const { stepUpToken } = await mfaApproval(subscriber.user);
      const response = await cancel(subscriber.user, {
        [HEADER]: stepUpToken,
      }).expect(200);
      expect(dataOf<CancellationView>(response)).toMatchObject({
        alreadyCanceled: true,
        canceledAt: canceledAt.toISOString(),
      });
      expect(await canceledEvents(subscriber.user)).toHaveLength(1);
    });

    it('the end of a subscription canceled with a step-up is processed without one', async () => {
      const subscriber = await mfaSubscriber();
      const { stepUpToken } = await mfaApproval(subscriber.user);
      await cancel(subscriber.user, { [HEADER]: stepUpToken }).expect(200);
      const canceled = await recordOf(subscriber.user);

      stripe.api.cancelSubscription(subscriber.subscriptionId);
      await webhook(
        stripe.api.signedSubscriptionEvent(
          'customer.subscription.deleted',
          subscriber.subscriptionId,
        ),
      ).expect(200);

      const after = await recordOf(subscriber.user);
      expect(after.proCanceledAt).toEqual(canceled.proCanceledAt);
      expect(after.proExpiresAt).toEqual(canceled.proExpiresAt);
      expect(await canceledEvents(subscriber.user)).toHaveLength(1);
    });

    it('a step-up approval never replaces the webhook signature', async () => {
      const subscriber = await mfaSubscriber();
      const { stepUpToken } = await mfaApproval(subscriber.user);
      await stripe.api
        .client()
        .subscriptions.update(subscriber.subscriptionId, {
          cancel_at_period_end: true,
        });
      const event = stripe.api.signedSubscriptionEvent(
        'customer.subscription.updated',
        subscriber.subscriptionId,
      );

      await request(ctx.app.getHttpServer())
        .post('/v1/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set(kit.as(subscriber.user))
        .set(HEADER, stepUpToken)
        .set('Stripe-Signature', 't=1,v1=forged')
        .send(event.payload)
        .expect(400);

      expect(await recordOf(subscriber.user)).toMatchObject({
        proCanceledAt: null,
      });
      expect(await canceledEvents(subscriber.user)).toHaveLength(0);
    });
  });
});
