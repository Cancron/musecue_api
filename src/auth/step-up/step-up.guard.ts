import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { StepUpAction, StepUpMethod } from '@prisma/client';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import AppError from '../../common/errors/app.error';
import type { IAccessTokenPayload } from '../interfaces/auth.interface';
import { STEP_UP } from './step-up.constants';
import { StepUpRepository } from './step-up.repository';

export const STEP_UP_ACTION = 'musecue:step-up-action';
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** What a passed step-up check attaches to the request. */
export interface StepUpContext {
  approvalId: string;
  action: StepUpAction;
  method: StepUpMethod;
}

/**
 * Lets a request through only with a step-up approval (X-Step-Up-Token) for
 * exactly this action, issued to this user in this sign-in session (the
 * access token's `sid`, still signed in), and less than 10 minutes old.
 * Anything else answers 403 before the handler runs, so nothing is read or
 * changed. Trusted devices play no part: they only skip the sign-in MFA
 * step. Must run after AuthGuard (use @RequireStepUp).
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly approvals: StepUpRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<StepUpAction | undefined>(
      STEP_UP_ACTION,
      [context.getHandler(), context.getClass()],
    );
    if (!action) return true;
    const request = context
      .switchToHttp()
      .getRequest<
        Request & { user?: IAccessTokenPayload; stepUp?: StepUpContext }
      >();
    const user = request.user;
    if (!user) throw new UnauthorizedException('No token found');

    const refuse = () =>
      AppError.forbidden(
        `Step-up authentication is required for this action (${action}). Confirm your identity through POST /v1/auth/step-up and send the approval in the X-Step-Up-Token header.`,
      );
    const header = request.headers[STEP_UP.HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token || !TOKEN_FORMAT.test(token) || !user.sid) throw refuse();

    const now = new Date();
    const approval = await this.approvals.findApproval(
      createHash('sha256').update(token, 'utf8').digest('hex'),
    );
    if (
      !approval ||
      approval.authId !== user.userId ||
      approval.sessionId !== user.sid ||
      approval.action !== action ||
      approval.expiresAt.getTime() <= now.getTime() ||
      !(await this.approvals.isSessionActive(user.userId, user.sid, now))
    ) {
      throw refuse();
    }
    await this.approvals.touchApproval(approval.id, now);
    request.stepUp = {
      approvalId: approval.id,
      action: approval.action,
      method: approval.method,
    };
    return true;
  }
}
