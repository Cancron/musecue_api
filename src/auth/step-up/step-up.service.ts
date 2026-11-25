import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { StepUpAction, StepUpMethod } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from 'winston';
import AppError from '../../common/errors/app.error';
import {
  decryptSecret,
  encryptSecret,
  SECRET_PURPOSES,
} from '../../common/security/derived-secrets';
import type { ActivityLogMetadata } from '../../common/services/activity-log.service';
import { PrismaService } from '../../common/services/prisma.service';
import { AuthService } from '../auth.service';
import type { IAccessTokenPayload } from '../interfaces/auth.interface';
import { MfaVerificationService } from '../mfa/mfa-verification.service';
import { GoogleOAuthService } from '../services/google-oauth.service';
import { STEP_UP } from './step-up.constants';
import { StepUpRepository } from './step-up.repository';

/** How this account confirms a sensitive action. */
export type StepUpRequirement = 'mfa' | 'password' | 'google';

export interface StepUpApprovalView {
  /** Send as the X-Step-Up-Token header; shown once, valid 10 minutes. */
  approvalToken: string;
  action: StepUpAction;
  method: StepUpMethod;
  expiresAt: Date;
}

export interface StepUpFactor {
  code?: string;
  recoveryCode?: string;
  password?: string;
}

interface StepUpAccount {
  id: string;
  email: string;
  status: string;
  provider: string;
  providerId: string | null;
  password: string;
  authSecurity: {
    mfaEnabled: boolean;
    failedAttempts: number;
    lockExpiresAt: Date | null;
  } | null;
}

const sha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/**
 * Step-up authentication: a fresh confirmation of the signed-in user's
 * identity before a sensitive action, bound to the user, the sign-in session
 * and the action, valid for 10 minutes. MFA accounts confirm with an
 * authenticator or unused recovery code; accounts without MFA with their
 * current password; accounts with neither (Google sign-in only) through a
 * one-time Google re-authentication. Trusted devices never replace it.
 */
@Injectable()
export class StepUpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: StepUpRepository,
    private readonly verification: MfaVerificationService,
    private readonly auth: AuthService,
    private readonly google: GoogleOAuthService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /** How the signed-in user confirms sensitive actions. */
  async requirement(
    user: IAccessTokenPayload,
  ): Promise<{ method: StepUpRequirement; approvalTtlSeconds: number }> {
    const account = await this.account(user.userId);
    return {
      method: this.requirementOf(account),
      approvalTtlSeconds: STEP_UP.APPROVAL_TTL_MS / 1000,
    };
  }

  /** Issues an approval after checking the account's own factor. */
  async approve(
    user: IAccessTokenPayload,
    action: StepUpAction,
    factor: StepUpFactor,
    meta: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<StepUpApprovalView> {
    const sessionId = await this.requireSession(user, now);
    const account = await this.account(user.userId);
    const requirement = this.requirementOf(account);
    const token = newToken();
    const approval = (method: StepUpMethod) => ({
      authId: account.id,
      sessionId,
      action,
      method,
      tokenHash: sha256(token),
      createdAt: now,
      expiresAt: new Date(now.getTime() + STEP_UP.APPROVAL_TTL_MS),
    });

    let method: StepUpMethod;
    if (requirement === 'mfa') {
      if (
        factor.password !== undefined ||
        (!factor.code && !factor.recoveryCode)
      ) {
        throw AppError.badRequest(
          'MFA is enabled for this account: confirm with the code from your authenticator app or an unused recovery code',
        );
      }
      const mfaFactor = factor.recoveryCode
        ? { recoveryCode: factor.recoveryCode }
        : { code: factor.code as string };
      // The approval is stored in the transaction that consumes the code:
      // one code, at most one approval.
      const verified = await this.verification.verifyWithin(
        account.id,
        mfaFactor,
        { ...meta, actionedBy: account.id },
        now,
        {
          onVerified: async (tx, verifiedWith) => {
            const m: StepUpMethod =
              verifiedWith === 'totp' ? 'TOTP' : 'RECOVERY_CODE';
            await this.repository.createApproval(approval(m), tx);
            return m;
          },
        },
      );
      method = verified.result as StepUpMethod;
    } else if (requirement === 'password') {
      if (factor.password === undefined) {
        throw AppError.badRequest('Confirm with your current password');
      }
      await this.checkPassword(account, factor.password, meta, now);
      method = 'PASSWORD';
      await this.repository.createApproval(approval(method));
    } else {
      throw AppError.badRequest(
        'This account signs in with Google only: confirm through POST /v1/auth/step-up/google',
      );
    }

    this.logger.info('Step-up approved', {
      context: 'StepUpService',
      userId: account.id,
      action,
      method,
    });
    return {
      approvalToken: token,
      action,
      method,
      expiresAt: new Date(now.getTime() + STEP_UP.APPROVAL_TTL_MS),
    };
  }

  /**
   * Starts a Google re-authentication (accounts without password and MFA):
   * a one-time challenge for this user, session and action, and the Google
   * URL to open. Google redirects to the sign-in callback, which forwards
   * `code` and `state` to `redirectUrl`; the app then completes it.
   */
  async startGoogle(
    user: IAccessTokenPayload,
    action: StepUpAction,
    redirectUrl: string | undefined,
    now: Date = new Date(),
  ): Promise<{ url: string; state: string; expiresAt: Date }> {
    const sessionId = await this.requireSession(user, now);
    const account = await this.account(user.userId);
    if (this.requirementOf(account) !== 'google') {
      throw AppError.badRequest(
        'Google re-authentication is only for accounts without a password or MFA: use POST /v1/auth/step-up',
      );
    }
    const state = newToken();
    const stateHash = sha256(state);
    const { codeVerifier, codeChallenge } = this.google.createPkcePair();
    const expiresAt = new Date(now.getTime() + STEP_UP.CHALLENGE_TTL_MS);
    await this.repository.createChallenge({
      authId: account.id,
      sessionId,
      action,
      stateHash,
      codeVerifier: encryptSecret(
        SECRET_PURPOSES.STEP_UP_CHALLENGE,
        codeVerifier,
        stateHash,
      ),
      redirectUrl: redirectUrl ?? null,
      createdAt: now,
      expiresAt,
    });
    const url = this.google.buildAuthorizationUrl({
      state,
      codeChallenge,
      loginHint: account.email,
      // Ask Google to show the account chooser / sign-in again.
      prompt: 'select_account',
    });
    return { url, state, expiresAt };
  }

  /**
   * Completes a Google re-authentication. The challenge is consumed by the
   * first attempt, whatever its outcome: unknown, repeated and expired
   * challenges, challenges of another user or session, and a Google account
   * other than the one this user signs in with are all refused (403).
   */
  async completeGoogle(
    user: IAccessTokenPayload,
    code: string,
    state: string,
    meta: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<StepUpApprovalView> {
    const sessionId = await this.requireSession(user, now);
    const stateHash = sha256(state);
    const challenge = await this.repository.consumeChallenge(stateHash, now);
    const reject = (reason: string, message: string) => {
      this.logger.warn('Google step-up rejected', {
        context: 'StepUpService',
        userId: user.userId,
        reason,
      });
      return AppError.forbidden(message);
    };
    if (!challenge) {
      throw reject(
        'unknown_or_used',
        'This Google re-authentication is invalid or was already used. Start a new one.',
      );
    }
    if (challenge.expiresAt.getTime() <= now.getTime()) {
      throw reject(
        'expired',
        'This Google re-authentication has expired. Start a new one.',
      );
    }
    if (challenge.authId !== user.userId || challenge.sessionId !== sessionId) {
      throw reject(
        'other_session',
        'This Google re-authentication belongs to another session.',
      );
    }
    const account = await this.account(user.userId);
    if (this.requirementOf(account) !== 'google') {
      throw reject(
        'requirement_changed',
        'This account no longer confirms with Google: use POST /v1/auth/step-up',
      );
    }
    let codeVerifier: string;
    try {
      codeVerifier = decryptSecret(
        SECRET_PURPOSES.STEP_UP_CHALLENGE,
        challenge.codeVerifier,
        stateHash,
      );
    } catch {
      throw reject('unreadable', 'This Google re-authentication is invalid.');
    }
    let identity: { sub: string; email_verified: boolean };
    try {
      identity = await this.google.identityFromCode(code, codeVerifier);
    } catch (error) {
      if (error instanceof HttpException) {
        throw reject('google_refused', 'Google re-authentication failed.');
      }
      throw error;
    }
    if (
      !identity.email_verified ||
      account.provider !== 'google' ||
      !account.providerId ||
      identity.sub !== account.providerId
    ) {
      throw reject(
        'identity_mismatch',
        'The Google account does not match the signed-in user.',
      );
    }

    const token = newToken();
    const expiresAt = new Date(now.getTime() + STEP_UP.APPROVAL_TTL_MS);
    await this.repository.createApproval({
      authId: account.id,
      sessionId,
      action: challenge.action,
      method: 'GOOGLE',
      tokenHash: sha256(token),
      createdAt: now,
      expiresAt,
    });
    this.logger.info('Step-up approved', {
      context: 'StepUpService',
      userId: account.id,
      action: challenge.action,
      method: 'GOOGLE',
    });
    return {
      approvalToken: token,
      action: challenge.action,
      method: 'GOOGLE',
      expiresAt,
    };
  }

  /** The access token's sign-in session, which must still be signed in. */
  private async requireSession(
    user: IAccessTokenPayload,
    now: Date,
  ): Promise<string> {
    if (
      !user.sid ||
      !(await this.repository.isSessionActive(user.userId, user.sid, now))
    ) {
      throw AppError.unauthorized(
        'This session can no longer confirm sensitive actions. Please sign in again.',
      );
    }
    return user.sid;
  }

  private async account(authId: string): Promise<StepUpAccount> {
    const account = await this.prisma.authUser.findUnique({
      where: { id: authId },
      select: {
        id: true,
        email: true,
        status: true,
        provider: true,
        providerId: true,
        password: true,
        authSecurity: {
          select: {
            mfaEnabled: true,
            failedAttempts: true,
            lockExpiresAt: true,
          },
        },
      },
    });
    if (!account || account.status !== 'ACTIVE') {
      throw AppError.unauthorized('User account is not active');
    }
    return account;
  }

  private requirementOf(account: StepUpAccount): StepUpRequirement {
    if (account.authSecurity?.mfaEnabled) return 'mfa';
    if (account.password) return 'password';
    if (account.provider === 'google' && account.providerId) return 'google';
    throw AppError.forbidden(
      'This account has no way to confirm sensitive actions',
    );
  }

  /** Checks the current password; wrong ones count toward the account lockout. */
  private async checkPassword(
    account: StepUpAccount,
    password: string,
    meta: ActivityLogMetadata,
    now: Date,
  ): Promise<void> {
    const security = account.authSecurity;
    if (security?.lockExpiresAt && security.lockExpiresAt > now) {
      throw AppError.forbidden(
        'Account is temporarily locked after too many incorrect passwords. Please try again later.',
      );
    }
    if (!(await bcrypt.compare(password, account.password))) {
      await this.auth.recordFailedPasswordConfirmation(
        account.id,
        security?.failedAttempts ?? 0,
        {
          ip: meta.ip ?? 'unknown',
          userAgent: meta.userAgent ?? 'unknown',
          device: meta.device,
        },
      );
      throw AppError.forbidden('Current password is incorrect');
    }
    if (security && security.failedAttempts > 0) {
      await this.prisma.authSecurity.update({
        where: { authId: account.id },
        data: { failedAttempts: 0, lastFailedAt: null },
      });
    }
  }
}
