import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import AppError from '../common/errors/app.error';
import { CreditWalletService } from '../credit/credit-wallet.service';
import {
  INSUFFICIENT_CREDITS_MESSAGE,
  InsufficientCreditsError,
} from '../credit/credit.errors';
import type { CreditBalanceView } from '../credit/interfaces/credit-wallet.interface';
import type { SubscriptionAccess } from './subscription-access.policy';
import { SubscriptionAccessService } from './subscription-access.service';

/** A request that has passed ProAccessGuard on a Pro feature route. */
export interface ProAccessRequest extends Request {
  user: { userId: string };
  /** The access decision made for this request; do not re-derive it. */
  proAccess: SubscriptionAccess;
}

/** A request that has passed ProAccessGuard on a `@RequireCredits()` route. */
export interface CreditAccessRequest extends Request {
  user: { userId: string };
  /** The credit balance the decision was based on; do not re-derive it. */
  creditAccess: CreditBalanceView;
}

export const PRO_ACCESS_REQUIRED_MESSAGE =
  'An active Pro subscription or free trial is required';
export { INSUFFICIENT_CREDITS_MESSAGE };

export const CREDITS_REQUIRED_KEY = 'proAccess:creditsRequired';

/**
 * Switches ProAccessGuard to credit eligibility for one route: access needs
 * available (unexpired, unused) credits from any source (trial,
 * subscription, purchase or referral) instead of an active Pro subscription
 * or trial. Purchased and referral credits therefore keep working after a
 * Pro subscription ends. Used only by POST /v1/sessions.
 */
export const RequireCredits = () => SetMetadata(CREDITS_REQUIRED_KEY, true);

/**
 * Protects Pro feature endpoints. Use after AuthGuard:
 *
 *   @UseGuards(AuthGuard, ProAccessGuard)
 *
 * By default the decision is made by SubscriptionAccessService (the free
 * trial and a paid Pro term unlock the same features, each within its own
 * date window), so no feature service decides Pro access on its own. Routes
 * marked `@RequireCredits()` are decided by the user's available credits
 * (CreditWalletService) instead, and are refused with 403 "Insufficient
 * credits". Routes without this guard are not restricted by it.
 *
 * The guard fails closed: a request without an authenticated user is
 * rejected, and lookup errors are not turned into access.
 */
@Injectable()
export class ProAccessGuard implements CanActivate {
  constructor(
    private readonly access: SubscriptionAccessService,
    private readonly credits: CreditWalletService,
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

    const creditsRequired = this.reflector.getAllAndOverride<
      boolean | undefined
    >(CREDITS_REQUIRED_KEY, [context.getHandler(), context.getClass()]);
    if (creditsRequired === true) {
      const balance = await this.credits.getBalance(userId);
      if (!hasAvailableCredits(balance)) {
        throw new InsufficientCreditsError();
      }
      Object.assign(request, { creditAccess: balance });
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

/** Any unexpired, unused credit counts (the balance excludes expired ones). */
function hasAvailableCredits(balance: CreditBalanceView): boolean {
  // Decimal strings such as "0", "0.000001" or "1000": positive when any
  // digit is non-zero (balances are never negative).
  return /[1-9]/.test(balance.availableCredits);
}
