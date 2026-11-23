import { userRole } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import request from 'supertest';
import {
  STRIPE_SETTINGS,
  type StripeSettings,
} from '../../src/subscription/stripe/stripe.config';
import { STRIPE_CLIENT } from '../../src/subscription/stripe/stripe.gateway';
import {
  bearerOf,
  createAccount,
  listen,
  nextTestIp,
  type TestAccount,
} from './discount-fixtures';
import { FAKE_WEBHOOK_SECRET, FakeStripeApi } from './fake-stripe-api';
import type { MockSmtpTransport } from './mock-smtp';
import {
  bootApplication,
  eventually,
  type TestApplication,
} from './infrastructure-flows';

/**
 * The complete application (AppModule: registration, email verification,
 * Stripe checkout and webhooks, referrals, credits, makeup sessions) on a
 * migrated PostgreSQL schema, with FakeStripeApi behind the real Stripe SDK.
 * Assign `stripe.api` to swap the fake.
 */
export interface ReferralApp {
  ctx: TestApplication;
  stripe: { api: FakeStripeApi };
}

export async function bootReferralApp(
  schema?: string,
  options: { smtp?: MockSmtpTransport } = {},
): Promise<ReferralApp> {
  const stripe = { api: new FakeStripeApi(5) };
  const client = new Stripe('sk_test_fake', {
    httpClient: Stripe.createFetchHttpClient(
      (input: string | URL | Request, init?: RequestInit) =>
        stripe.api.fetch(input, init),
    ),
    maxNetworkRetries: 0,
    telemetry: false,
  });
  const settings: StripeSettings = {
    secretKey: 'sk_test_fake',
    webhookSecret: FAKE_WEBHOOK_SECRET,
    successUrl: 'https://app.example/checkout/success',
    cancelUrl: 'https://app.example/checkout/cancel',
    productId: null,
    checkoutExpiresMinutes: 60,
  };
  const ctx = await bootApplication({
    schema,
    smtp: options.smtp,
    overrides: [
      { provide: STRIPE_SETTINGS, useValue: settings },
      { provide: STRIPE_CLIENT, useValue: client },
    ],
  });
  await listen(ctx);
  return { ctx, stripe };
}

export interface SignedUp extends TestAccount {
  email: string;
  password: string;
}

export interface MilestoneView {
  id: string;
  referralCount: number;
  rewardCredits: number;
  active: boolean;
  /** Referrers who reached it. */
  awards: number;
}

export const dataOf = <T>(response: { body: unknown }) =>
  (response.body as { data: T }).data;
export const messageOf = (response: { body: unknown }) =>
  (response.body as { message: string }).message;

export function referralFlows(app: ReferralApp) {
  const http = () => request(app.ctx.app.getHttpServer());
  const as = (account: TestAccount) => bearerOf(account);

  const helpers = {
    http,
    as,
    /** An ADMIN account (tokens minted by the production token code). */
    admin: () => createAccount(app.ctx, userRole.ADMIN),
    setDiscountSettings: (admin: TestAccount, body: Record<string, number>) =>
      http()
        .patch('/v1/admin/discount-settings')
        .set('X-Forwarded-For', nextTestIp())
        .set('Authorization', as(admin))
        .send(body)
        .expect(200),

    /** POST /auth (registration) from a fresh client address. */
    register: (body: Record<string, unknown>) =>
      http().post('/auth').set('X-Forwarded-For', nextTestIp()).send(body),
    newIdentity: (prefix = 'user') => {
      const tag = randomBytes(5).toString('hex');
      return {
        username: `${prefix}_${tag}`.slice(0, 20),
        email: `${prefix}_${tag}@example.com`,
        password: 'correct horse battery staple',
      };
    },
    /**
     * Registration (optionally with a referral code), verification with the
     * emailed code and password login, over HTTP.
     */
    signUp: async (
      options: { referralCode?: string; email?: string; prefix?: string } = {},
    ): Promise<SignedUp> => {
      const identity = helpers.newIdentity(options.prefix);
      const email = options.email ?? identity.email;
      await helpers
        .register({
          username: identity.username,
          email,
          password: identity.password,
          ...(options.referralCode !== undefined
            ? { referralCode: options.referralCode }
            : {}),
        })
        .expect(201);
      const sent = await eventually(
        () =>
          Promise.resolve(
            app.ctx.emails.sent.find(
              (item) => item.kind === 'verification' && item.to === email,
            ),
          ),
        30_000,
        'the verification email',
      );
      await http()
        .post('/auth/verify-email')
        .set('X-Forwarded-For', nextTestIp())
        .send({ email, code: sent.code })
        .expect(201);
      const login = dataOf<{ user: { id: string } }>(
        await http()
          .post('/auth/login')
          .set('X-Forwarded-For', nextTestIp())
          .send({ email, password: identity.password })
          .expect(201),
      );
      return {
        id: login.user.id,
        role: userRole.USER,
        email,
        password: identity.password,
      };
    },

    get: (account: TestAccount, path: string) =>
      http()
        .get(path)
        .set('X-Forwarded-For', nextTestIp())
        .set('Authorization', as(account)),
    post: (account: TestAccount, path: string, body: object = {}) =>
      http()
        .post(path)
        .set('X-Forwarded-For', nextTestIp())
        .set('Authorization', as(account))
        .send(body),
    /** The caller's referral code (GET /v1/referrals). */
    codeOf: async (account: TestAccount) =>
      dataOf<{ code: string }>(
        await helpers.get(account, '/v1/referrals').expect(200),
      ).code,

    /** Opens a Pro checkout; returns its id and response. */
    checkout: async (
      account: TestAccount,
      body: Record<string, unknown> = { billingInterval: 'MONTHLY' },
    ) =>
      dataOf<{
        checkoutSessionId: string;
        amountDueCents: number;
        discount: { source: string; amountOffCents: number } | null;
      }>(
        await helpers
          .post(account, '/v1/subscription/checkout', body)
          .expect(201),
      ),
    sessionId: async (checkoutId: string) =>
      (
        await app.ctx.client.checkoutSession.findUniqueOrThrow({
          where: { id: checkoutId },
        })
      ).providerSessionId as string,
    webhook: (signed: { payload: string; signature: string }) =>
      http()
        .post('/v1/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signed.signature)
        .send(signed.payload),
    sessionEvent: (type: string, sessionId: string) =>
      helpers.webhook(app.stripe.api.signedEvent(type, sessionId)),
    invoiceEvent: (type: string, invoiceId: string) =>
      helpers.webhook(app.stripe.api.signedInvoiceEvent(type, invoiceId)),

    /** Checkout, payment on the hosted page, verified webhook. */
    buyPro: async (
      account: TestAccount,
      body: Record<string, unknown> = { billingInterval: 'MONTHLY' },
      /** The card the customer pays with (Stripe card fingerprint). */
      options: { cardFingerprint?: string } = {},
    ) => {
      const checkout = await helpers.checkout(account, body);
      const sessionId = await helpers.sessionId(checkout.checkoutSessionId);
      app.stripe.api.completeSession(sessionId, options);
      await helpers
        .sessionEvent('checkout.session.completed', sessionId)
        .expect(200);
      const session = app.stripe.api.sessions.get(sessionId) as {
        subscription: string;
        invoice: string;
      };
      return {
        checkout,
        sessionId,
        subscriptionId: session.subscription,
        invoiceId: session.invoice,
      };
    },

    /** Pays an opened checkout on the hosted page (no webhook yet). */
    payCheckout: async (
      checkoutId: string,
      options: { cardFingerprint?: string } = {},
    ) => {
      const sessionId = await helpers.sessionId(checkoutId);
      app.stripe.api.completeSession(sessionId, options);
      return sessionId;
    },
    patch: (account: TestAccount, path: string, body: object = {}) =>
      http()
        .patch(path)
        .set('X-Forwarded-For', nextTestIp())
        .set('Authorization', as(account))
        .send(body),
    notificationsOf: (authId: string) =>
      app.ctx.client.notification.findMany({
        where: { authId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    notificationEmailsTo: (email: string) =>
      app.ctx.emails.sent.filter(
        (item) => item.kind === 'notification' && item.to === email,
      ),
    /**
     * Referral milestones through the admin API. Milestones apply to every
     * referrer of the application: `reset` switches them all off, `ensure`
     * creates one or switches it on with the given reward.
     */
    milestones: (admin: TestAccount) => {
      const path = '/v1/admin/referral-milestones';
      const list = async () =>
        dataOf<MilestoneView[]>(await helpers.get(admin, path).expect(200));
      return {
        list,
        reset: async () => {
          for (const m of await list()) {
            if (m.active) {
              await helpers
                .patch(admin, `${path}/${m.id}`, { active: false })
                .expect(200);
            }
          }
        },
        ensure: async (referralCount: number, rewardCredits: number) => {
          const existing = (await list()).find(
            (m) => m.referralCount === referralCount,
          );
          const response = existing
            ? await helpers
                .patch(admin, `${path}/${existing.id}`, {
                  rewardCredits,
                  active: true,
                })
                .expect(200)
            : await helpers
                .post(admin, path, { referralCount, rewardCredits })
                .expect(201);
          return dataOf<MilestoneView>(response);
        },
      };
    },
    referralOf: (authId: string) =>
      app.ctx.client.referral.findUnique({ where: { authId } }),
    rewardAllocations: (authId: string) =>
      app.ctx.client.creditAllocation.findMany({
        where: { authId, source: 'REFERRAL' },
        orderBy: { grantedAt: 'asc' },
      }),
  };
  return helpers;
}
