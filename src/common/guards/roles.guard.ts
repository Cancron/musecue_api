import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { UserRole } from '../../auth/interfaces/auth.interface';
import { ROLES_KEY } from '../decorators/roles.decorator';

interface RequestWithUser extends Request {
  user?: { role?: unknown };
}

/**
 * Role-based authorization. Runs after AuthGuard and trusts the role claim of
 * the access token AuthGuard has already verified (signature, expiry and
 * tokenVersion), so it performs no database lookup.
 *
 * Fails closed: a route using this guard without `@Roles(...)` metadata
 * rejects every request.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowedRoles = this.reflector.getAllAndOverride<
      UserRole[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!allowedRoles || allowedRoles.length === 0) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      throw new UnauthorizedException('Authentication required');
    }

    const role = request.user.role;
    if (!allowedRoles.some((allowed) => allowed === role)) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
