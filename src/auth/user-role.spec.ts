import { userRole } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import { RedisService } from '../common/services/redis.service';
import { AUTH_CONFIG } from './config/auth.config';
import { UserRole } from './interfaces/auth.interface';
import { AuthUtilsService } from './services/auth-utils.service';

describe('UserRole normalization', () => {
  it('uses exactly the role names stored by Prisma', () => {
    expect(UserRole).toEqual(userRole);
    expect(Object.values(UserRole).sort()).toEqual([
      'ADMIN',
      'MODERATOR',
      'SUPERADMIN',
      'USER',
    ]);
  });

  it('ranks every role in the hierarchy', () => {
    expect(AUTH_CONFIG.ROLE_HIERARCHY).toEqual({
      USER: 1,
      MODERATOR: 2,
      ADMIN: 3,
      SUPERADMIN: 4,
    });
  });

  describe('canModifyRole with normalized names', () => {
    const utils = new AuthUtilsService(mock<RedisService>());

    it.each([
      [UserRole.SUPERADMIN, UserRole.USER, UserRole.ADMIN, true],
      [UserRole.SUPERADMIN, UserRole.SUPERADMIN, UserRole.ADMIN, false],
      [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.SUPERADMIN, false],
      [UserRole.ADMIN, UserRole.USER, UserRole.MODERATOR, true],
      [UserRole.ADMIN, UserRole.MODERATOR, UserRole.ADMIN, false],
      [UserRole.ADMIN, UserRole.ADMIN, UserRole.USER, false],
      [UserRole.MODERATOR, UserRole.USER, UserRole.USER, true],
      [UserRole.MODERATOR, UserRole.USER, UserRole.MODERATOR, false],
      [UserRole.USER, UserRole.USER, UserRole.USER, false],
    ])('%s changing %s to %s -> %s', (actor, target, next, expected) => {
      expect(utils.canModifyRole(actor, target, next)).toBe(expected);
    });
  });
});
