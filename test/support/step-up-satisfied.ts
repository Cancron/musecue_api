import type { CanActivate } from '@nestjs/common';

/**
 * For HTTP specs of a protected route that test something else (export
 * contents, deletion rules, Stripe cancellation, plan administration, ...)
 * on in-memory fakes: stands in for StepUpGuard (a valid step-up approval
 * was sent) or AdminMfaGuard (the administrator verified MFA). The guards
 * themselves are covered by their own specs and by test/mfa-step-up and
 * test/mfa-admin-policy (real guards, real PostgreSQL).
 */
export const stepUpSatisfied: CanActivate = {
  canActivate: () => true,
};
