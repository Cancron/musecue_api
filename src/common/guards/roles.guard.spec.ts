import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../auth/interfaces/auth.interface';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const adminRoles = [UserRole.ADMIN, UserRole.SUPERADMIN];

  const contextFor = (
    user: unknown,
    roles: UserRole[] | undefined,
  ): ExecutionContext => {
    const handler = () => undefined;
    if (roles) Reflect.defineMetadata(ROLES_KEY, roles, handler);
    return {
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  };

  it.each([UserRole.ADMIN, UserRole.SUPERADMIN])(
    'allows a verified %s token',
    (role) => {
      expect(
        guard.canActivate(contextFor({ userId: 'u1', role }, adminRoles)),
      ).toBe(true);
    },
  );

  it.each([UserRole.USER, UserRole.MODERATOR])('forbids a %s token', (role) => {
    expect(() =>
      guard.canActivate(contextFor({ userId: 'u1', role }, adminRoles)),
    ).toThrow(ForbiddenException);
  });

  it.each(['SUPER_ADMIN', 'CUSTOMER', 'admin', undefined, 42])(
    'forbids a token with the unknown role %p',
    (role) => {
      expect(() =>
        guard.canActivate(contextFor({ userId: 'u1', role }, adminRoles)),
      ).toThrow(ForbiddenException);
    },
  );

  it('rejects a request that AuthGuard has not authenticated', () => {
    expect(() => guard.canActivate(contextFor(undefined, adminRoles))).toThrow(
      UnauthorizedException,
    );
  });

  it('fails closed when a route has no @Roles metadata', () => {
    expect(() =>
      guard.canActivate(
        contextFor({ userId: 'u1', role: UserRole.SUPERADMIN }, undefined),
      ),
    ).toThrow(ForbiddenException);
  });
});
