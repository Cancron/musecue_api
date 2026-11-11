import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import AppError from '../common/errors/app.error';
import type { SubscriptionAccess } from './subscription-access.policy';
import { SubscriptionAccessService } from './subscription-access.service';

/** A request that has passed ProAccessGuard. */
export interface ProAccessRequest extends Request {
  user: { userId: string };
  /** The access decision made for this request; do not re-derive it. */
  proAccess: SubscriptionAccess;
}

export const PRO_ACCESS_REQUIRED_MESSAGE =
  'An active Pro subscription or free trial is required';

/**
 * Protects Pro feature endpoints. Use after AuthGuard:
 *
 *   @UseGuards(AuthGuard, ProAccessGuard)
 *
 * The decision is made by SubscriptionAccessService (the free trial and a
 * paid Pro term unlock the same features, each within its own date window),
 * so no feature service decides Pro access on its own. The guard fails closed:
 * a request without an authenticated user is rejected, and lookup errors are
 * not turned into access.
 */
@Injectable()
export class ProAccessGuard implements CanActivate {
  constructor(private readonly access: SubscriptionAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: { userId?: unknown } }>();
    const userId = request.user?.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authentication required');
    }

    const decision = await this.access.getAccess(userId);
    if (!decision.hasProAccess) {
      throw AppError.forbidden(PRO_ACCESS_REQUIRED_MESSAGE);
    }

    Object.assign(request, { proAccess: decision });
    return true;
  }
}
