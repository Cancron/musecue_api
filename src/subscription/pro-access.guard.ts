import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import AppError from '../common/errors/app.error';
import {
  INSUFFICIENT_CREDITS_MESSAGE,
  InsufficientCreditsError,
} from '../credits/credit-wallet.errors';
import {
  CreditEligibilityService,
  type CreditEligibility,
} from './credit-eligibility.service';
import { REQUIRE_CREDITS_KEY } from './require-credits.decorator';
import type { SubscriptionAccess } from './subscription-access.policy';
import { SubscriptionAccessService } from './subscription-access.service';

/** A request that has passed ProAccessGuard. */
export interface ProAccessRequest extends Request {
  user: { userId: string };
  /** The access decision made for this request; do not re-derive it. */
  proAccess: SubscriptionAccess;
}

/** A request that has passed ProAccessGuard on a `@RequireCredits()` handler. */
export interface CreditAccessRequest extends ProAccessRequest {
  /** The credit decision made for this request; do not re-derive it. */
  creditAccess: CreditEligibility;
}

export const PRO_ACCESS_REQUIRED_MESSAGE =
  'An active Pro subscription or free trial is required';

export { INSUFFICIENT_CREDITS_MESSAGE };

/**
 * Protects Pro feature endpoints. Use after AuthGuard:
 *
 *   @UseGuards(AuthGuard, ProAccessGuard)
 *
 * Two modes, chosen per handler:
 *
 * - Credit eligibility (handlers marked `@RequireCredits()`, currently only
 *   POST /v1/sessions): the request passes if the user has usable credits,
 *   otherwise 403 "Insufficient credits". Due trial and monthly Pro
 *   allowances are granted first. Purchased and referral credits count with
 *   or without Pro; trial and subscription credits only while that trial or
 *   paid term is active (CreditEligibilityService).
 * - Pro access (every other handler using the guard): the request passes
 *   during an active trial or paid term, otherwise 403 "An active Pro
 *   subscription or free trial is required" (SubscriptionAccessService).
 *
 * Endpoints without the guard are not restricted by it. The guard fails
 * closed: a request without an authenticated user is rejected, and lookup
 * errors are not turned into access.
 */
@Injectable()
export class ProAccessGuard implements CanActivate {
  constructor(
    private readonly access: SubscriptionAccessService,
    private readonly credits: CreditEligibilityService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: { userId?: unknown } }>();
    const userId = request.user?.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authentication required');
    }

    const requireCredits = this.reflector.getAllAndOverride<
      boolean | undefined
    >(REQUIRE_CREDITS_KEY, [context.getHandler(), context.getClass()]);
    if (requireCredits === true) {
      const eligibility = await this.credits.getEligibility(userId);
      if (!eligibility.eligible) {
        // The same error (403 "Insufficient credits") as a wallet debit the
        // balance cannot cover.
        throw new InsufficientCreditsError({
          available: eligibility.usableCredits,
        });
      }
      Object.assign(request, {
        proAccess: eligibility.proAccess,
        creditAccess: eligibility,
      });
      return true;
    }

    const decision = await this.access.getAccess(userId);
    if (!decision.hasProAccess) {
      throw AppError.forbidden(PRO_ACCESS_REQUIRED_MESSAGE);
    }

    Object.assign(request, { proAccess: decision });
    return true;
  }
}
