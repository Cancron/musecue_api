import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { requestMetadata } from '../request-metadata';
import { StripeWebhookService } from './stripe-webhook.service';

/**
 * Stripe webhook endpoint. Not behind AuthGuard: Stripe authenticates each
 * request with the `Stripe-Signature` header, verified against the raw body
 * before anything is read. Requires `rawBody: true` in NestFactory.create.
 * Throttling is skipped so Stripe's retries are never rate-limited.
 *
 * Responds 200 once an event is handled or deliberately ignored, 400 for an
 * invalid signature, and 5xx on transient failures so Stripe retries.
 */
@SkipThrottle()
@Controller('v1/webhooks/stripe')
export class StripeWebhookController {
  constructor(private readonly webhooks: StripeWebhookService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    const event = this.webhooks.verifyEvent(req.rawBody, signature);
    await this.webhooks.handleEvent(event, requestMetadata(req));
    return { received: true };
  }
}
