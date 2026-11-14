import type { AccountDeletionStatus } from '@prisma/client';

/** An accepted account deletion request as returned to the client. */
export interface AccountDeletionView {
  id: string;
  status: AccountDeletionStatus;
  requestedAt: string;
  accountBlockedAt: string;
  /** Whether every session has already been revoked (otherwise pending). */
  sessionsRevoked: boolean;
  message: string;
}

export interface ConfirmationCodeView {
  message: string;
  expiresAt: string;
}
