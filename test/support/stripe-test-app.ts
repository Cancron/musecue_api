import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import Stripe from 'stripe';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import { UserRole } from '../../src/auth/interfaces/auth.interface';
import { AuthUtilsService } from '../../src/auth/services/auth-utils.service';
import config from '../../src/common/config/app.config';
import { AllExceptionsFilter } from '../../src/common/filters/all-exception.filter';
import { TransformInterceptor } from '../../src/common/interceptors/transform.interceptor';
import { CustomLoggerService } from '../../src/common/services/custom-logger.service';
import { PrismaService } from '../../src/common/services/prisma.service';
import { RedisService } from '../../src/common/services/redis.service';
import {
  STRIPE_SETTINGS,
  type StripeSettings,
} from '../../src/subscription/stripe/stripe.config';
import { STRIPE_CLIENT } from '../../src/subscription/stripe/stripe.gateway';
import { SubscriptionModule } from '../../src/subscription/subscription.module';
import { FAKE_WEBHOOK_SECRET, FakeStripeApi } from './fake-stripe-api';
import {
  TEST_DATABASE_URL,
  applyMigrations,
  createSchema,
  dropSchema,
  migrationNames,
} from './migrated-schema';

/**
 * The real Nest HTTP stack with SubscriptionModule, its services and Prisma
 * on a freshly migrated PostgreSQL schema (row locks, partial unique indexes,
 * CHECK constraints and triggers), and Stripe replaced by FakeStripeApi
 * behind the real Stripe SDK. Assign `stripe.api` to swap the fake per test.
 */
export interface StripeTestApp {
  app: INestApplication<App>;
  client: PrismaClient;
  stripe: { api: FakeStripeApi };
  bearer(userId: string): string;
  /** POST /v1/subscription/checkout as `userId`. */
  startCheckout(userId: string, billingInterval: string): request.Test;
  /** GET /v1/subscription as `userId`; resolves the response data. */
  status(userId: string): Promise<Record<string, unknown>>;
  /** Delivers a signed webhook through POST /v1/webhooks/stripe. */
  sendWebhook(payload: string, signature: string): request.Test;
  close(): Promise<void>;
}

/** The `data` of the standard response envelope. */
export const dataOf = (response: { body: unknown }) =>
  (response.body as { data: Record<string, string> }).data;

export async function createStripeTestApp(): Promise<StripeTestApp> {
  const schema = await createSchema();
  await applyMigrations(schema, migrationNames());
  // Raw SQL (the FOR UPDATE row locks) resolves tables via search_path.
  const url = new URL(TEST_DATABASE_URL as string);
  url.searchParams.set('options', `-c search_path="${schema}"`);
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.toString() }, { schema }),
  });

  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useValue: client },
      { provide: CustomLoggerService, useValue: mock<CustomLoggerService>() },
    ],
    exports: [PrismaService, CustomLoggerService],
  })
  class TestInfrastructureModule {}

  const stripe = { api: new FakeStripeApi(5) };
  const stripeClient = new Stripe('sk_test_fake', {
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

  const redis = mock<RedisService>();
  redis.get.mockResolvedValue(1 as never);
  const originalSecret = config.jwt_access_secret;
  config.jwt_access_secret = `stripe-e2e-${schema}`;
  const moduleRef = await Test.createTestingModule({
    imports: [TestInfrastructureModule, SubscriptionModule],
  })
    .overrideProvider(RedisService)
    .useValue(redis)
    .overrideProvider(STRIPE_SETTINGS)
    .useValue(settings)
    .overrideProvider(STRIPE_CLIENT)
    .useValue(stripeClient)
    .compile();
  // Same option as main.ts: keeps the raw body for webhook signatures.
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    rawBody: true,
  });
  const logger = mock<Logger>();
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.useGlobalInterceptors(new TransformInterceptor(logger));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  // Listen once: otherwise supertest starts and closes the shared server for
  // every request, which resets concurrent requests (ECONNRESET).
  await app.listen(0, '127.0.0.1');

  const tokens = new AuthUtilsService(mock<RedisService>());
  const bearer = (userId: string) =>
    `Bearer ${tokens.createAccessToken({ userId, role: UserRole.USER, tokenVersion: 1 })}`;

  return {
    app,
    client,
    stripe,
    bearer,
    startCheckout: (userId, billingInterval) =>
      request(app.getHttpServer())
        .post('/v1/subscription/checkout')
        .set('Authorization', bearer(userId))
        .send({ billingInterval }),
    status: (userId) =>
      request(app.getHttpServer())
        .get('/v1/subscription')
        .set('Authorization', bearer(userId))
        .expect(200)
        .then((response) => dataOf(response) as Record<string, unknown>),
    sendWebhook: (payload, signature) =>
      request(app.getHttpServer())
        .post('/v1/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .set('User-Agent', 'Stripe/1.0 (+https://stripe.com/docs/webhooks)')
        .send(payload),
    close: async () => {
      await app.close();
      await client.$disconnect();
      await dropSchema(schema);
      config.jwt_access_secret = originalSecret;
    },
  };
}
