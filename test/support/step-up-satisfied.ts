import type { CanActivate } from '@nestjs/common';

/**
 * For HTTP specs of a sensitive route that test something else (export
 * contents, deletion rules, Stripe cancellation, ...) on in-memory fakes:
 * stands in for StepUpGuard as if a valid step-up approval was sent. Step-up
 * itself is covered by src/auth/step-up/*.spec.ts and
 * test/mfa-step-up.e2e-spec.ts (real guard, real PostgreSQL).
 */
export const stepUpSatisfied: CanActivate = {
  canActivate: () => true,
};
