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
import { RedisService } from '../../common/services/redis.service';
import { SubscriptionModule } from '../subscription.module';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';
import { STRIPE_SETTINGS, type StripeSettings } from './stripe.config';
import { STRIPE_CLIENT } from './stripe.gateway';

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: mockDeep<PrismaService>() },
    { provide: CustomLoggerService, useValue: mock<CustomLoggerService>() },
  ],
  exports: [PrismaService, CustomLoggerService],
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
      .overrideProvider(RedisService)
      .useValue(mock<RedisService>())
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
  });

  it('returns 500 on a processing failure so Stripe retries', async () => {
    handleEvent.mockRejectedValue(new Error('database unavailable'));
    const { payload, signature } = signedBody();
    await post(payload, signature).expect(500);
  });

  it('is excluded from rate limiting so Stripe retries are never throttled', () => {
    expect(
      Reflect.getMetadata('THROTTLER:SKIPdefault', StripeWebhookController),
    ).toBe(true);
  });
});
