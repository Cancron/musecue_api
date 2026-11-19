import { SetMetadata } from '@nestjs/common';

export const REQUIRE_CREDITS_KEY = 'requireCredits';

/**
 * Switches ProAccessGuard to credit eligibility for this handler: the
 * request passes only if the user has usable credits (from any source,
 * with or without Pro), otherwise 403 "Insufficient credits". Use with
 * `@UseGuards(AuthGuard, ProAccessGuard)`.
 */
export const RequireCredits = () => SetMetadata(REQUIRE_CREDITS_KEY, true);
