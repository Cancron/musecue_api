import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { StepUpAction } from '@prisma/client';
import { STEP_UP_ACTION, StepUpGuard } from './step-up.guard';

/**
 * Requires a step-up approval for `action` (see StepUpGuard). Put it on a
 * handler of a controller already guarded by AuthGuard (class-level guards
 * run first).
 */
export const RequireStepUp = (action: StepUpAction) =>
  applyDecorators(
    SetMetadata(STEP_UP_ACTION, action),
    UseGuards(StepUpGuard),
    ApiHeader({
      name: 'X-Step-Up-Token',
      required: true,
      description: `Step-up approval for ${action} (POST /v1/auth/step-up), valid 10 minutes`,
    }),
  );
