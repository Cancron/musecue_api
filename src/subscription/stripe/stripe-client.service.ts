import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import AppError from '../../common/errors/app.error';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { getStripeCredentials } from './stripe.config';

/**
 * Thin wrapper around the Stripe SDK used by checkout and the webhook.
 *
 * The SDK client is created lazily on first use (not in the constructor) so
 * the app can boot without `STRIPE_SECRET_KEY` configured; only a request
 * that actually needs Stripe fails, the same pattern `GoogleOAuthService`
 * uses for its credentials.
 */
@Injectable()
export class StripeClientService {
  private readonly context = 'StripeClientService';
  private client: Stripe | null = null;

  constructor(private readonly customLogger: CustomLoggerService) {}

  private getClient(): Stripe {
    if (!this.client) {
      const { secretKey } = getStripeCredentials();
      this.client = new Stripe(secretKey);
    }
    return this.client;
  }

  async createCustomer(
    params: Stripe.CustomerCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Customer> {
    return this.getClient().customers.create(params, options);
  }

  async createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Checkout.Session> {
    return this.getClient().checkout.sessions.create(params, options);
  }

  /**
   * Best-effort: if the session is already expired, completed, or otherwise
   * gone on Stripe's side, there is nothing left to undo there. Callers
   * always also update their own record's status, which is the source of
   * truth for whether the session can still be reused.
   */
  async expireCheckoutSession(providerSessionId: string): Promise<void> {
    try {
      await this.getClient().checkout.sessions.expire(providerSessionId);
    } catch (error) {
      this.customLogger.warn(
        `Failed to expire Stripe checkout session ${providerSessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        this.context,
      );
    }
  }

  /**
   * Verifies the webhook signature and returns the parsed event.
   * @throws AppError.badRequest if the payload or signature is invalid.
   */
  constructWebhookEvent(
    payload: string | Buffer,
    signature: string | string[] | undefined,
  ): Stripe.Event {
    if (!signature) {
      throw AppError.badRequest('Missing Stripe-Signature header');
    }
    const { webhookSecret } = getStripeCredentials();
    try {
      return this.getClient().webhooks.constructEvent(
        payload,
        signature,
        webhookSecret,
      );
    } catch (error) {
      this.customLogger.warn(
        `Rejected webhook with an invalid signature: ${
          error instanceof Error ? error.message : String(error)
        }`,
        this.context,
      );
      throw AppError.badRequest('Invalid Stripe webhook signature');
    }
  }
}
