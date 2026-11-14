import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Logger } from 'winston';
import AppError from '../../common/errors/app.error';
import { AllExceptionsFilter } from '../../common/filters/all-exception.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';

describe('POST /v1/subscription/stripe/webhook (HTTP)', () => {
  let app: INestApplication<App>;
  const webhook = mock<StripeWebhookService>();
  const ROUTE = '/v1/subscription/stripe/webhook';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StripeWebhookController],
      providers: [{ provide: StripeWebhookService, useValue: webhook }],
    }).compile();

    // Raw-body capture must be enabled the same way main.ts enables it, since
    // the controller verifies the signature against the exact request bytes.
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
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('requires no Authorization header (Stripe calls it directly)', async () => {
    webhook.handleWebhook.mockResolvedValue(undefined);
    await request(app.getHttpServer())
      .post(ROUTE)
      .set('Stripe-Signature', 'sig_1')
      .send({ type: 'checkout.session.completed' })
      .expect(200);
  });

  it('passes the raw request bytes and signature header to the service', async () => {
    webhook.handleWebhook.mockResolvedValue(undefined);

    await request(app.getHttpServer())
      .post(ROUTE)
      .set('Stripe-Signature', 'sig_test_1')
      .send({ type: 'checkout.session.completed' })
      .expect(200, {
        statusCode: 200,
        message: 'Success',
        data: { received: true },
      });

    expect(webhook.handleWebhook.mock.calls).toHaveLength(1);
    const [rawBody, signature] = webhook.handleWebhook.mock.calls[0] ?? [];
    expect(Buffer.isBuffer(rawBody)).toBe(true);
    expect(JSON.parse(rawBody.toString())).toEqual({
      type: 'checkout.session.completed',
    });
    expect(signature).toBe('sig_test_1');
  });

  it('returns 400 when the service rejects an invalid signature', async () => {
    webhook.handleWebhook.mockRejectedValue(
      AppError.badRequest('Invalid Stripe webhook signature'),
    );

    const response = await request(app.getHttpServer())
      .post(ROUTE)
      .set('Stripe-Signature', 'bad-sig')
      .send({ type: 'checkout.session.completed' })
      .expect(400);

    expect(response.body).toMatchObject({
      success: false,
      statusCode: 400,
      message: 'Invalid Stripe webhook signature',
    });
  });

  it('never activates anything from the HTTP layer itself; it only forwards to the verified handler', async () => {
    webhook.handleWebhook.mockResolvedValue(undefined);
    await request(app.getHttpServer())
      .post(ROUTE)
      .query({ session_id: 'cs_test_1', activate: 'true' })
      .set('Stripe-Signature', 'sig_1')
      .send({ type: 'checkout.session.completed' })
      .expect(200);

    // Only the body/signature are used; a query string can never trigger
    // activation on its own.
    expect(webhook.handleWebhook.mock.calls[0]?.[1]).toBe('sig_1');
  });
});
