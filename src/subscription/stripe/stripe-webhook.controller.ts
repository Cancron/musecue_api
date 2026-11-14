import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import AppError from '../../common/errors/app.error';
import { StripeWebhookService } from './stripe-webhook.service';

/**
 * Stripe calls this endpoint directly (no user session, no JWT). The
 * signature on every request is verified against `STRIPE_WEBHOOK_SECRET`
 * before anything is processed; this is the only way a checkout ever
 * activates Pro access.
 */
@ApiExcludeController()
@Controller('v1/subscription/stripe/webhook')
export class StripeWebhookController {
  constructor(private readonly webhook: StripeWebhookService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!req.rawBody) {
      throw AppError.badRequest('Missing request body');
    }
    await this.webhook.handleWebhook(req.rawBody, signature);
    return { received: true };
  }
}
