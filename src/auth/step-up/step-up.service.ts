import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { Prisma, StepUpAction, StepUpMethod } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import AppError from '../../common/errors/app.error';
import type { ActivityLogMetadata } from '../../common/services/activity-log.service';
import { PrismaService } from '../../common/services/prisma.service';
import { AuthService } from '../auth.service';
import {
  GOOGLE_OAUTH_CONFIG,
  getGoogleOAuthCredentials,
} from '../config/google-oauth.config';
import type { IAccessTokenPayload } from '../interfaces/auth.interface';
import type { MfaFactor } from '../mfa/mfa-verification.service';
import { MfaVerificationService } from '../mfa/mfa-verification.service';
import { MfaRepository } from '../mfa/mfa.repository';
import { GoogleOAuthService } from '../services/google-oauth.service';
import { OAuthStateRepository } from '../state/oauth-state.repository';
import { RefreshSessionRepository } from '../state/refresh-session.repository';
import { STEP_UP, type StepUpRequirement } from './step-up.constants';

/** An approval: the token is returned only here. */
export interface StepUpApprovalView {
  stepUpToken: string;
  action: StepUpAction;
  method: StepUpMethod;
  expiresAt: Date;
}

/** The proof sent to POST /auth/step-up. */
export interface StepUpProof {
  action: StepUpAction;
  code?: string;
  recoveryCode?: string;
  password?: string;
}

/** A started Google reauthentication. */
export interface GoogleStepUpStart {
  url: string;
  state: string;
  expiresAt: Date;
}

/** What a Google reauthentication challenge is bound to (encrypted state). */
interface GoogleStepUpState {
  authId: string;
  sessionId: string;
  action: StepUpAction;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  createdAt: string;
}

type Principal = Pick<IAccessTokenPayload, 'userId' | 'sid'>;

const CONTEXT = 'StepUpService';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Step-up authentication: issues ten-minute approvals for one sensitive
 * action in the caller's sign-in session, after a fresh proof of identity
 * that depends on the account (never on the client's choice):
 *
 * - MFA enabled: the authenticator code or an unused recovery code (same
 *   checks, replay protection and lockout as the MFA step of sign-in);
 * - no MFA, with a password: the current password (wrong passwords count
 *   toward the account lockout);
 * - no MFA, no password (Google-only): a new Google sign-in, bound by a
 *   one-time challenge to the user, the session and the action.
 *
 * Trusted devices play no part: a step-up is always required.
 */
@Injectable()
export class StepUpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: RefreshSessionRepository,
    private readonly mfa: MfaRepository,
    private readonly verification: MfaVerificationService,
    private readonly auth: AuthService,
    private readonly google: GoogleOAuthService,
    private readonly oauthStates: OAuthStateRepository,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /** How the caller re-verifies, and the actions that need it. */
  async requirementFor(authId: string): Promise<StepUpRequirement> {
    const account = await this.account(authId);
    return account.requirement;
  }

  /** Step-up with an authenticator code, a recovery code or a password. */
  async approve(
    principal: Principal,
    proof: StepUpProof,
    meta: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<StepUpApprovalView> {
    const sessionId = await this.requireSession(principal, now);
    const account = await this.account(principal.userId);

    let approval: StepUpApprovalView;
    if (account.requirement === 'mfa') {
      approval = await this.approveWithMfa(
        principal.userId,
        sessionId,
        proof,
        meta,
        now,
      );
    } else if (account.requirement === 'password') {
      approval = await this.approveWithPassword(
        principal.userId,
        sessionId,
        proof,
        meta,
        now,
      );
    } else {
      throw AppError.badRequest(
        'This account has no password: reauthenticate with Google (POST /auth/step-up/google)',
      );
    }
    this.logger.info('Step-up approved', {
      context: CONTEXT,
      authId: principal.userId,
      action: approval.action,
      method: approval.method,
    });
    return approval;
  }

  /**
   * Starts a Google reauthentication for a Google-only account: a one-time
   * challenge (state, PKCE verifier and nonce) bound to the user, the
   * session and the action, valid for ten minutes.
   */
  async startGoogle(
    principal: Principal,
    action: StepUpAction,
    now: Date = new Date(),
  ): Promise<GoogleStepUpStart> {
    const sessionId = await this.requireSession(principal, now);
    const account = await this.account(principal.userId);
    if (account.requirement !== 'google') {
      throw AppError.badRequest(
        account.requirement === 'mfa'
          ? 'This account uses MFA: approve with an authenticator or recovery code'
          : 'This account has a password: approve with the password',
      );
    }
    const { clientId, redirectUri: signInRedirect } = this.googleCredentials();
    const redirectUri =
      process.env.GOOGLE_STEP_UP_REDIRECT_URI?.trim() || signInRedirect;

    const state = randomBytes(32).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const payload: GoogleStepUpState = {
      authId: principal.userId,
      sessionId,
      action,
      codeVerifier,
      nonce,
      redirectUri,
      createdAt: now.toISOString(),
    };
    await this.oauthStates.create(
      STEP_UP.GOOGLE_STATE_PROVIDER,
      state,
      payload,
      STEP_UP.TTL_MS / 1000,
      now,
    );

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_OAUTH_CONFIG.SCOPES.join(' '),
      state,
      nonce,
      code_challenge: createHash('sha256')
        .update(codeVerifier)
        .digest('base64url'),
      code_challenge_method: 'S256',
      // Ask Google for a fresh, interactive sign-in of this account, and for
      // the time of that sign-in (auth_time) in the signed ID token: max_age
      // makes auth_time required (OpenID Connect), and the claims request
      // marks it essential. A callback without it is refused.
      prompt: 'select_account',
      max_age: '0',
      claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }),
      login_hint: account.email,
    });
    return {
      url: `${GOOGLE_OAUTH_CONFIG.ENDPOINTS.AUTHORIZATION}?${params.toString()}`,
      state,
      expiresAt: new Date(now.getTime() + STEP_UP.TTL_MS),
    };
  }

  /**
   * Completes a Google reauthentication with the callback's `code` and
   * `state`, sent with the access token of the session that started it. The
   * challenge is used up by the first attempt, whatever its outcome. Refused
   * (403): unknown, expired or repeated challenges, another user's or
   * session's challenge, a token for another nonce, another Google account,
   * or a sign-in older than the challenge.
   */
  async completeGoogle(
    principal: Principal,
    callback: { code: string; state: string },
    now: Date = new Date(),
  ): Promise<StepUpApprovalView> {
    const sessionId = await this.requireSession(principal, now);
    const challenge = await this.oauthStates.consume<GoogleStepUpState>(
      STEP_UP.GOOGLE_STATE_PROVIDER,
      callback.state,
      now,
    );
    if (!challenge) {
      throw AppError.forbidden(
        'The Google reauthentication is invalid, expired or already used. Start again.',
      );
    }
    if (
      challenge.authId !== principal.userId ||
      challenge.sessionId !== sessionId
    ) {
      this.refused(principal.userId, 'session_mismatch');
      throw AppError.forbidden(
        'This Google reauthentication belongs to another session. Start again.',
      );
    }
    const account = await this.account(principal.userId);
    if (account.requirement !== 'google' || !account.providerId) {
      throw AppError.forbidden(
        'Google reauthentication is not available for this account',
      );
    }

    const tokens = await this.google.exchangeCodeForTokens(
      callback.code,
      challenge.codeVerifier,
      challenge.redirectUri,
    );
    if (!tokens.id_token) {
      throw AppError.forbidden(
        'Google did not confirm the identity. Start again.',
      );
    }
    const claims = await this.google.verifyIdToken(tokens.id_token);

    if (!claims.nonce || !safeEqual(claims.nonce, challenge.nonce)) {
      this.refused(principal.userId, 'nonce_mismatch');
      throw AppError.forbidden(
        'The Google sign-in does not belong to this reauthentication. Start again.',
      );
    }
    if (!safeEqual(claims.sub, account.providerId)) {
      this.refused(principal.userId, 'identity_mismatch');
      throw AppError.forbidden(
        'The Google account does not match this account. Sign in with the same Google account.',
      );
    }
    if (!this.isFreshSignIn(claims.auth_time, challenge.createdAt, now)) {
      this.refused(
        principal.userId,
        claims.auth_time === undefined
          ? 'google_auth_time_missing'
          : 'stale_google_sign_in',
      );
      throw AppError.forbidden(
        'Google did not confirm a new sign-in. Start again.',
      );
    }

    const approval = await this.createApproval(this.prisma, {
      authId: principal.userId,
      sessionId,
      action: challenge.action,
      method: 'GOOGLE',
      now,
    });
    this.logger.info('Step-up approved', {
      context: CONTEXT,
      authId: principal.userId,
      action: approval.action,
      method: approval.method,
    });
    return approval;
  }

  /**
   * The signed ID token must state when the user signed in (`auth_time`,
   * seconds), and that must be after this reauthentication started (allowing
   * a small clock skew) and not in the future. Anything else does not prove a
   * fresh authentication.
   */
  private isFreshSignIn(
    authTime: unknown,
    challengeCreatedAt: string,
    now: Date,
  ): boolean {
    if (typeof authTime !== 'number' || !Number.isFinite(authTime)) {
      return false;
    }
    const signedInAt = authTime * 1000;
    const startedAt = new Date(challengeCreatedAt).getTime();
    return (
      signedInAt >= startedAt - STEP_UP.GOOGLE_AUTH_TIME_SKEW_MS &&
      signedInAt <= now.getTime() + STEP_UP.GOOGLE_AUTH_TIME_SKEW_MS
    );
  }

  private async approveWithMfa(
    authId: string,
    sessionId: string,
    proof: StepUpProof,
    meta: ActivityLogMetadata,
    now: Date,
  ): Promise<StepUpApprovalView> {
    if (proof.password !== undefined) {
      throw AppError.badRequest(
        'This account uses MFA: approve with code or recoveryCode, not the password',
      );
    }
    const factor = this.factorOf(proof);
    const outcome = await this.guardStorage(() =>
      this.mfa.withLock(authId, async (uow) => {
        const checked = await this.verification.checkFactor(
          uow,
          authId,
          factor,
          meta,
          now,
        );
        if (checked.kind !== 'VERIFIED') {
          return { kind: 'DECLINED' as const, declined: checked };
        }
        // Same transaction as the code's consumption.
        const approval = await this.createApproval(uow.tx, {
          authId,
          sessionId,
          action: proof.action,
          method: factor.method === 'totp' ? 'TOTP' : 'RECOVERY_CODE',
          now,
        });
        return { kind: 'APPROVED' as const, approval };
      }),
    );
    if (outcome.kind === 'DECLINED') {
      throw this.verification.declinedError(authId, outcome.declined);
    }
    return outcome.approval;
  }

  private async approveWithPassword(
    authId: string,
    sessionId: string,
    proof: StepUpProof,
    meta: ActivityLogMetadata,
    now: Date,
  ): Promise<StepUpApprovalView> {
    if (proof.code !== undefined || proof.recoveryCode !== undefined) {
      throw AppError.badRequest(
        'MFA is not enabled for this account: approve with the password',
      );
    }
    if (!proof.password) {
      throw AppError.badRequest('password is required');
    }
    const user = await this.prisma.authUser.findUniqueOrThrow({
      where: { id: authId },
      select: {
        password: true,
        authSecurity: {
          select: { id: true, failedAttempts: true, lockExpiresAt: true },
        },
      },
    });
    const security = user.authSecurity;
    if (security?.lockExpiresAt && security.lockExpiresAt > now) {
      throw AppError.forbidden(
        'Account is temporarily locked after too many incorrect passwords',
      );
    }
    if (!(await bcrypt.compare(proof.password, user.password))) {
      await this.auth.recordFailedPasswordConfirmation(
        authId,
        security?.failedAttempts ?? 0,
        {
          ip: meta.ip ?? 'unknown',
          userAgent: meta.userAgent ?? 'unknown',
          device: meta.device,
        },
      );
      this.refused(authId, 'incorrect_password');
      throw AppError.forbidden('Incorrect password');
    }
    if (security && security.failedAttempts > 0) {
      await this.prisma.authSecurity.update({
        where: { id: security.id },
        data: { failedAttempts: 0, lastFailedAt: null, lockExpiresAt: null },
      });
    }
    return this.createApproval(this.prisma, {
      authId,
      sessionId,
      action: proof.action,
      method: 'PASSWORD',
      now,
    });
  }

  private async createApproval(
    client: Prisma.TransactionClient | PrismaService,
    input: {
      authId: string;
      sessionId: string;
      action: StepUpAction;
      method: StepUpMethod;
      now: Date;
    },
  ): Promise<StepUpApprovalView> {
    const stepUpToken = `stup_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(input.now.getTime() + STEP_UP.TTL_MS);
    await client.stepUpApproval.create({
      data: {
        authId: input.authId,
        sessionId: input.sessionId,
        action: input.action,
        method: input.method,
        tokenHash: sha256(stepUpToken),
        createdAt: input.now,
        expiresAt,
      },
    });
    return {
      stepUpToken,
      action: input.action,
      method: input.method,
      expiresAt,
    };
  }

  /** The caller's sign-in session, which must still be active. */
  private async requireSession(principal: Principal, now: Date) {
    if (!principal.sid) {
      throw AppError.unauthorized(
        'This session cannot approve sensitive actions. Please sign in again.',
      );
    }
    const active = await this.sessions.isSessionActive(
      principal.userId,
      principal.sid,
      now,
    );
    if (!active) {
      throw AppError.unauthorized(
        'This session has ended. Please sign in again.',
      );
    }
    return principal.sid;
  }

  private async account(authId: string) {
    const user = await this.prisma.authUser.findUnique({
      where: { id: authId },
      select: {
        email: true,
        status: true,
        password: true,
        provider: true,
        providerId: true,
        authSecurity: { select: { mfaEnabled: true } },
      },
    });
    if (!user) throw AppError.unauthorized('User not found');
    if (user.status !== 'ACTIVE') {
      throw AppError.forbidden('User account is not active');
    }
    let requirement: StepUpRequirement;
    if (user.authSecurity?.mfaEnabled) requirement = 'mfa';
    else if (user.password) requirement = 'password';
    else if (user.provider === 'google' && user.providerId) {
      requirement = 'google';
    } else {
      throw AppError.forbidden('This account cannot be re-verified');
    }
    return {
      email: user.email,
      providerId: user.providerId,
      requirement,
    };
  }

  private factorOf(proof: StepUpProof): MfaFactor {
    const hasCode = proof.code !== undefined;
    const hasRecovery = proof.recoveryCode !== undefined;
    if (hasCode === hasRecovery) {
      throw AppError.badRequest('Provide exactly one of code or recoveryCode');
    }
    return hasCode
      ? { method: 'totp', code: proof.code as string }
      : { method: 'recovery_code', code: proof.recoveryCode as string };
  }

  private googleCredentials() {
    try {
      return getGoogleOAuthCredentials();
    } catch {
      throw AppError.serviceUnavailable(
        'Google reauthentication is not configured',
      );
    }
  }

  private refused(authId: string, reason: string) {
    this.logger.warn('Step-up refused', { context: CONTEXT, authId, reason });
  }

  private async guardStorage<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('Step-up could not be recorded', {
        context: CONTEXT,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw AppError.serviceUnavailable(
        'Step-up authentication is temporarily unavailable. Please try again.',
      );
    }
  }
}
