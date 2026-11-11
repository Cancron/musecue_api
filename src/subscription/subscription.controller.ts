import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { IAccessTokenPayload } from '../auth/interfaces/auth.interface';
import { AuthGuard } from '../common/guards/auth.guard';
import { requestMetadata } from './request-metadata';
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
}
