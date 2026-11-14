import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { IAccessTokenPayload } from '../auth/interfaces/auth.interface';
import { AuthGuard } from '../common/guards/auth.guard';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { requestMetadata } from './request-metadata';
import { StripeCancellationService } from './stripe/stripe-cancellation.service';
import { StripeCheckoutService } from './stripe/stripe-checkout.service';
import { SubscriptionAccessService } from './subscription-access.service';
import { SubscriptionTrialService } from './subscription-trial.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/** The authenticated user's own subscription. */
@ApiTags('subscription')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/subscription')
export class SubscriptionController {
  constructor(
    private readonly access: SubscriptionAccessService,
    private readonly trials: SubscriptionTrialService,
    private readonly checkout: StripeCheckoutService,
    private readonly cancellation: StripeCancellationService,
  ) {}

  /** The caller's subscription status, trial eligibility and dates. */
  @Get()
  getMySubscription(@Req() req: AuthenticatedRequest) {
    return this.access.getStatus(req.user.userId);
  }

  /** Starts the one-time free trial for the caller. Takes no request body. */
  @Post('trial')
  activateTrial(@Req() req: AuthenticatedRequest) {
    return this.trials.activateTrial(req.user.userId, requestMetadata(req));
  }

  /**
   * Starts (or reuses) a Stripe checkout for the Pro plan at the backend
   * price of the chosen billing option. Returns the hosted payment URL. Pro
   * access is granted only after Stripe's verified webhook confirms payment,
   * never by this call or by the checkout's success redirect.
   */
  @Post('checkout')
  createCheckout(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateCheckoutSessionDto,
  ) {
    return this.checkout.createCheckout(req.user.userId, dto.billingInterval);
  }

  /**
   * Cancels the caller's own paid subscription at the end of its period:
   * auto-renewal is turned off through Stripe and Pro access continues until
   * the paid period ends. Takes no request body; the subscription is always
   * the token user's. Repeating the request returns the same cancellation.
   */
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  cancelSubscription(@Req() req: AuthenticatedRequest) {
    return this.cancellation.cancelAtPeriodEnd(
      req.user.userId,
      requestMetadata(req),
    );
  }
}
