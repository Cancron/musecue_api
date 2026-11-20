import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { StepUpAction, StepUpMethod } from '@prisma/client';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import AppError from '../../common/errors/app.error';
import { PrismaService } from '../../common/services/prisma.service';
import type { IAccessTokenPayload } from '../interfaces/auth.interface';
import { STEP_UP, STEP_UP_ACTION_KEY } from './step-up.constants';

/** The approval a request was admitted with (set on `request.stepUp`). */
export interface StepUpContext {
  action: StepUpAction;
  method: StepUpMethod;
  approvalId: string;
}

/**
 * Requires a valid step-up approval (`X-Step-Up-Token`) for routes marked
 * with @RequireStepUp(action). Runs after AuthGuard and before any pipe or
 * handler, so a refused request changes nothing. The approval must belong
 * to the token's user and sign-in session (`sid`), be for this action, be
 * less than ten minutes old, and its session must still be active (logout
 * and logout-all end every approval of the session). Anything else: 403.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<StepUpAction | undefined>(
      STEP_UP_ACTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!action) return true;

    const request = context
      .switchToHttp()
      .getRequest<
        Request & { user?: IAccessTokenPayload; stepUp?: StepUpContext }
      >();
    const header = request.headers[STEP_UP.HEADER];
    if (typeof header !== 'string' || header.length === 0) {
      throw AppError.forbidden(
        `Step-up authentication is required for this action (${action})`,
      );
    }

    const user = request.user;
    const now = new Date();
    const approval =
      user?.sid && STEP_UP.TOKEN_PATTERN.test(header)
        ? await this.approved(user.userId, user.sid, action, header, now)
        : null;
    if (!approval) {
      throw AppError.forbidden(
        `The step-up approval is missing, expired or not valid for this action (${action}). Verify again.`,
      );
    }
    request.stepUp = {
      action,
      method: approval.method,
      approvalId: approval.id,
    };
    return true;
  }

  /** The matching approval, or null. */
  private async approved(
    authId: string,
    sessionId: string,
    action: StepUpAction,
    token: string,
    now: Date,
  ): Promise<{ id: string; method: StepUpMethod } | null> {
    const approval = await this.prisma.stepUpApproval.findUnique({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
      select: {
        id: true,
        method: true,
        authId: true,
        sessionId: true,
        action: true,
        expiresAt: true,
      },
    });
    if (
      !approval ||
      approval.authId !== authId ||
      approval.sessionId !== sessionId ||
      approval.action !== action ||
      approval.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }
    const activeSessions = await this.prisma.refreshSession.count({
      where: {
        authId,
        familyId: sessionId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });
    return activeSessions > 0
      ? { id: approval.id, method: approval.method }
      : null;
  }
}
