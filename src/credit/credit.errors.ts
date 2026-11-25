import { HttpStatus } from '@nestjs/common';
import AppError from '../common/errors/app.error';

export const INSUFFICIENT_CREDITS_MESSAGE = 'Insufficient credits';

/**
 * The user does not have the credits an operation needs: 403 "Insufficient
 * credits". Used both when access to a credit-gated route is refused
 * (ProAccessGuard with @RequireCredits()) and when a deduction exceeds the
 * available credits plus the session's overage room.
 */
export class InsufficientCreditsError extends AppError {
  constructor(details?: {
    requestedCredits: string;
    availableCredits: string;
    overageRoomCredits: string;
  }) {
    super(HttpStatus.FORBIDDEN, INSUFFICIENT_CREDITS_MESSAGE, details);
  }
}

/**
 * A source event or idempotency key was already used with different terms,
 * for another user, or (for trials) a second trial allocation was attempted.
 */
export class CreditConflictError extends AppError {
  constructor(message: string) {
    super(HttpStatus.CONFLICT, message);
  }
}
