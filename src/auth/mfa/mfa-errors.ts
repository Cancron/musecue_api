import { HttpException } from '@nestjs/common';
import type { Logger } from 'winston';
import AppError from '../../common/errors/app.error';
import type { MfaAccountState } from './mfa.repository';

/**
 * Runs a storage operation: storage or key failures become a 503, never a
 * wrong-code answer; HTTP errors raised inside pass through.
 */
export async function guardMfaStorage<T>(
  logger: Logger,
  context: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    logger.error('MFA state could not be read or written', {
      context,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw AppError.serviceUnavailable(
      'MFA is temporarily unavailable. Please try again.',
    );
  }
}

/** The token's user must still exist and be active. */
export function requireActiveAccount(
  account: MfaAccountState | null,
): MfaAccountState {
  if (!account) throw AppError.unauthorized('User not found');
  if (account.status !== 'ACTIVE') {
    throw AppError.forbidden('User account is not active');
  }
  return account;
}

export function mfaBlockedError(what: string, until: Date): AppError {
  return AppError.tooManyRequests(
    `Too many incorrect codes. ${what} is blocked until ${until.toISOString()}.`,
  );
}
