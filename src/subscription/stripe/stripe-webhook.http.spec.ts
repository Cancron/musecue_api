import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mock, mockDeep } from 'jest-mock-extended';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import {
  FAKE_WEBHOOK_SECRET,
  FakeStripeApi,
} from '../../../test/support/fake-stripe-api';
import { AllExceptionsFilter } from '../../common/filters/all-exception.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { TokenVersionCache } from '../../infrastructure/token-version/token-version.cache';
import { SubscriptionModule } from '../subscription.module';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';
import { STRIPE_SETTINGS, type StripeSettings } from './stripe.config';
import { STRIPE_CLIENT } from './stripe.gateway';

const prisma = mockDeep<PrismaService>();

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: CustomLoggerService, useValue: mock<CustomLoggerService>() },
    { provide: TokenVersionCache, useValue: mock<TokenVersionCache>() },
  ],
  exports: [PrismaService, CustomLoggerService, TokenVersionCache],
})
class TestInfrastructureModule {}

const ROUTE = '/v1/webhooks/stripe';

describe('POST /v1/webhooks/stripe (HTTP)', () => {
  const api = new FakeStripeApi();
  const settings: StripeSettings = {
    secretKey: 'sk_test_fake',
    webhookSecret: FAKE_WEBHOOK_SECRET,
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/cancel',
    productId: null,
    checkoutExpiresMinutes: 60,
  };
  let app: INestApplication<App>;
  let handleEvent: jest.SpyInstance;

  const signedBody = () => {
    const payload = JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type: 'checkout.session.completed',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'cs_test_1', object: 'checkout.session' } },
    });
    return {
      payload,
      signature: api.client().webhooks.generateTestHeaderString({
        payload,
        secret: FAKE_WEBHOOK_SECRET,
      }),
    };
  };

  const post = (payload: string, signature?: string) => {
    const call = request(app.getHttpServer())
      .post(ROUTE)
      .set('Content-Type', 'application/json')
      .set('User-Agent', 'Stripe/1.0 (+https://stripe.com/docs/webhooks)');
    if (signature !== undefined) call.set('Stripe-Signature', signature);
    return call.send(payload);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestInfrastructureModule, SubscriptionModule],
    })
      .overrideProvider(STRIPE_SETTINGS)
      .useValue(settings)
      .overrideProvider(STRIPE_CLIENT)
      .useValue(api.client())
      .compile();
    // Same option as main.ts: keeps the unparsed body for signatures.
    app = moduleRef.createNestApplication({ rawBody: true });
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
    handleEvent = jest.spyOn(app.get(StripeWebhookService), 'handleEvent');
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    handleEvent.mockReset();
    handleEvent.mockResolvedValue('ACTIVATED');
    prisma.paymentWebhookEvent.upsert.mockReset();
    prisma.paymentWebhookEvent.update.mockReset();
    prisma.paymentWebhookEvent.updateMany.mockReset();
    prisma.paymentWebhookEvent.upsert.mockResolvedValue({
      id: 'log-1',
    } as never);
    prisma.paymentWebhookEvent.update.mockResolvedValue({
      id: 'log-1',
    } as never);
    prisma.paymentWebhookEvent.updateMany.mockResolvedValue({
      count: 1,
    } as never);
  });

  it('accepts a signed event without a bearer token and hands it to the service', async () => {
    const { payload, signature } = signedBody();

    const response = await post(payload, signature).expect(200);

    expect(response.body).toEqual({
      statusCode: 200,
      message: 'Success',
      data: { received: true },
    });
    expect(handleEvent).toHaveBeenCalledTimes(1);
    expect(handleEvent.mock.calls[0]).toEqual([
      expect.objectContaining({
        id: 'evt_1',
        type: 'checkout.session.completed',
      }),
      expect.objectContaining({
        userAgent: expect.stringContaining('Stripe') as string,
      }),
    ]);
  });

  it('verifies the exact bytes that were sent', async () => {
    const { payload, signature } = signedBody();
    // Same JSON, different whitespace: the signature no longer matches.
    const reformatted = JSON.stringify(JSON.parse(payload), null, 2);
    await post(reformatted, signature).expect(400);
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['no signature header', (p: string) => [p, undefined]],
    ['a forged signature', (p: string) => [p, 't=1700000000,v1=abc123']],
    [
      'a tampered payload',
      (p: string, s: string) => [p.replace('cs_test_1', 'cs_test_9'), s],
    ],
  ])('rejects %s with 400 and processes nothing', async (_label, mutate) => {
    const { payload, signature } = signedBody();
    const [body, header] = mutate(payload, signature);
    const response = await post(body as string, header).expect(400);
    expect(response.body).toMatchObject({
      success: false,
      message: 'Invalid webhook signature',
    });
    expect(handleEvent).not.toHaveBeenCalled();
    // Nothing is written, not even the event log.
    expect(prisma.paymentWebhookEvent.upsert.mock.calls).toHaveLength(0);
    expect(prisma.paymentWebhookEvent.update.mock.calls).toHaveLength(0);
  });

  it('returns 500 on a processing failure so Stripe retries', async () => {
    handleEvent.mockRejectedValue(new Error('database unavailable'));
    const { payload, signature } = signedBody();
    await post(payload, signature).expect(500);
  });

  it('never returns internal error details to the caller', async () => {
    handleEvent.mockRejectedValue(
      Object.assign(
        new Error('insert into "PaymentTransaction" failed for user 42'),
        { code: 'P2002' },
      ),
    );
    const { payload, signature } = signedBody();

    const response = await post(payload, signature).expect(500);

    expect(response.body).toMatchObject({
      statusCode: 500,
      message: 'Webhook processing failed',
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /PaymentTransaction|user 42|P2002/,
    );
    // The failure is recorded (as an error class only) for redelivery,
    // unless a concurrent delivery of the event has processed it meanwhile.
    expect(
      prisma.paymentWebhookEvent.updateMany.mock.calls.at(-1)?.[0],
    ).toEqual({
      where: { id: 'log-1', status: 'RECEIVED' },
      data: { status: 'FAILED', processedAt: null, lastErrorCode: 'db:P2002' },
    });
  });

  it('logs a verified event before processing it, and its outcome after', async () => {
    const { payload, signature } = signedBody();
    const order: string[] = [];
    prisma.paymentWebhookEvent.upsert.mockImplementation((() => {
      order.push('logged');
      return Promise.resolve({ id: 'log-1' });
    }) as never);
    handleEvent.mockImplementation(() => {
      order.push('handled');
      return Promise.resolve('ACTIVATED');
    });

    await post(payload, signature).expect(200);

    expect(order).toEqual(['logged', 'handled']);
    expect(prisma.paymentWebhookEvent.upsert.mock.calls[0]?.[0]).toMatchObject({
      where: {
        provider_providerEventId: {
          provider: 'stripe',
          providerEventId: 'evt_1',
        },
      },
      create: {
        type: 'checkout.session.completed',
        objectId: 'cs_test_1',
        livemode: false,
      },
      update: { attempts: { increment: 1 } },
    });
    expect(
      prisma.paymentWebhookEvent.update.mock.calls.at(-1)?.[0],
    ).toMatchObject({ data: { status: 'PROCESSED', outcome: 'ACTIVATED' } });
  });

  it('is excluded from rate limiting so Stripe retries are never throttled', () => {
    expect(
      Reflect.getMetadata('THROTTLER:SKIPdefault', StripeWebhookController),
    ).toBe(true);
  });
});
