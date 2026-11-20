import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { StepUpAction } from '@prisma/client';
import { STEP_UP_ACTION_KEY } from './step-up.constants';
import { StepUpGuard } from './step-up.guard';

/**
 * Marks a route as sensitive: it needs a step-up approval for `action`
 * (POST /auth/step-up), sent as the X-Step-Up-Token header. Use it on routes
 * that already run AuthGuard (class-level guards run first); provide
 * StepUpGuard in the route's module.
 */
export const RequireStepUp = (action: StepUpAction) =>
  applyDecorators(
    SetMetadata(STEP_UP_ACTION_KEY, action),
    UseGuards(StepUpGuard),
    ApiHeader({
      name: 'X-Step-Up-Token',
      required: true,
      description: `Step-up approval for ${action} (POST /auth/step-up)`,
    }),
  );
