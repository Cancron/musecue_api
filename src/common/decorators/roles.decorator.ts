import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../auth/interfaces/auth.interface';

export const ROLES_KEY = 'roles';

/**
 * Restricts a handler or controller to the listed roles. Must be combined
 * with `@UseGuards(AuthGuard, RolesGuard)`: AuthGuard verifies the access
 * token and RolesGuard checks the role it carries.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
