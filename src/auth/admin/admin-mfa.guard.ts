import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import AppError from '../../common/errors/app.error';
import { PrismaService } from '../../common/services/prisma.service';
import type { IAccessTokenPayload } from '../interfaces/auth.interface';

/** The MFA policy of administrator operations. */
export const ADMIN_MFA_POLICY = {
  /** Roles that must prove MFA before any administrator operation. */
  ROLES: ['ADMIN', 'SUPERADMIN'] as readonly string[],
  /** How long a session's MFA proof counts for administrator operations. */
  MAX_AGE_MS: 12 * 60 * 60_000,
  /**
   * The only proofs accepted: the authenticator app or a recovery code.
   * Trusted devices never produce a proof, and no other method (for example
   * SMS) is accepted.
   */
  METHODS: ['totp', 'recovery_code'] as readonly string[],
} as const;

/**
 * Administrator operations require MFA. Runs after AuthGuard and RolesGuard
 * on every administrator route. An ADMIN or SUPERADMIN passes only when:
 *
 * 1. MFA is enabled on the account with an authenticator app, and
 * 2. the current sign-in session (the token's `sid`) proved MFA within the
 *    last 12 hours with the authenticator or a recovery code: at an MFA
 *    sign-in, with POST /auth/mfa/verify, an MFA step-up or the MFA
 *    activation.
 *
 * A session opened through a trusted device has no proof until the
 * administrator verifies MFA in it. Anything else: 403, and nothing runs.
 */
@Injectable()
export class AdminMfaGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: IAccessTokenPayload }>();
    const user = request.user;
    if (!user) throw AppError.unauthorized('Authentication required');
    if (!ADMIN_MFA_POLICY.ROLES.includes(user.role)) return true;

    const security = await this.prisma.authSecurity.findUnique({
      where: { authId: user.userId },
      select: { mfaEnabled: true, mfaMethod: true, mfaSecret: true },
    });
    if (
      !security?.mfaEnabled ||
      security.mfaMethod !== 'totp' ||
      !security.mfaSecret
    ) {
      throw AppError.forbidden(
        'Administrators must enable MFA with an authenticator app before using administrator operations',
      );
    }

    const now = new Date();
    const proven =
      !!user.sid &&
      (await this.prisma.refreshSession.count({
        where: {
          authId: user.userId,
          familyId: user.sid,
          revokedAt: null,
          expiresAt: { gt: now },
          mfaVerifiedAt: {
            gte: new Date(now.getTime() - ADMIN_MFA_POLICY.MAX_AGE_MS),
          },
          mfaVerifiedWith: { in: [...ADMIN_MFA_POLICY.METHODS] },
        },
      })) > 0;
    if (!proven) {
      throw AppError.forbidden(
        'Verify MFA in this session (POST /auth/mfa/verify) to use administrator operations',
      );
    }
    return true;
  }
}
