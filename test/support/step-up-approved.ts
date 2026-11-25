import type { CanActivate } from '@nestjs/common';

/**
 * Replaces StepUpGuard in controller tests that are about something else
 * (validation, ownership, response contracts): every request counts as
 * step-up approved. Step-up itself is covered by the step-up unit tests, the
 * route inventory (src/auth/step-up/step-up.routes.spec.ts) and
 * test/mfa-step-up.e2e-spec.ts.
 */
export const STEP_UP_APPROVED: CanActivate = { canActivate: () => true };
