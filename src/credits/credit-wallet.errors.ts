import { HttpStatus } from '@nestjs/common';
import AppError from '../common/errors/app.error';

/**
 * Errors of the credit wallet. They extend AppError so that a future HTTP
 * route can let them through unchanged; `code` identifies the case.
 */
export class CreditWalletError extends AppError {
  constructor(
    status: HttpStatus,
    message: string,
    readonly code: string,
    details?: Record<string, unknown>,
  ) {
    super(status, message, { code, ...details });
  }
}

export class InvalidCreditOperationError extends CreditWalletError {
  constructor(message: string) {
    super(HttpStatus.BAD_REQUEST, message, 'INVALID_CREDIT_OPERATION');
  }
}

export class CreditOwnerNotFoundError extends CreditWalletError {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'User not found', 'CREDIT_OWNER_NOT_FOUND');
  }
}

export class CreditSessionNotFoundError extends CreditWalletError {
  constructor() {
    super(
      HttpStatus.NOT_FOUND,
      'Makeup session not found',
      'CREDIT_SESSION_NOT_FOUND',
    );
  }
}

/**
 * The same source event or idempotency key was already used with different
 * values (or a second trial grant was attempted). Nothing was written.
 */
export class CreditConflictError extends CreditWalletError {
  constructor(message: string) {
    super(HttpStatus.CONFLICT, message, 'CREDIT_CONFLICT');
  }
}

export const INSUFFICIENT_CREDITS_MESSAGE = 'Insufficient credits';

/**
 * The user's credits cannot cover what was asked: a debit beyond the balance
 * and any session overage, or creating a makeup session without usable
 * credits (ProAccessGuard). Always 403 "Insufficient credits", so clients see
 * one response for both. Nothing was written.
 */
export class InsufficientCreditsError extends CreditWalletError {
  constructor(details: {
    requested?: string;
    available: string;
    overageRemaining?: string;
  }) {
    super(
      HttpStatus.FORBIDDEN,
      INSUFFICIENT_CREDITS_MESSAGE,
      'INSUFFICIENT_CREDITS',
      details,
    );
  }
}
