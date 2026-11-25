import { HttpStatus } from '@nestjs/common';
import AppError from '../common/errors/app.error';

/** A deduction does not fit the available credits plus the overage room. */
export class InsufficientCreditsError extends AppError {
  constructor(details: {
    requestedCredits: string;
    availableCredits: string;
    overageRoomCredits: string;
  }) {
    super(HttpStatus.PAYMENT_REQUIRED, 'Insufficient credits', details);
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
