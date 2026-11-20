import type { SecurityNotificationEvent } from '../../src/common/queues/email/security-notifications';
import type {
  MfaSecurityNotifier,
  PendingSecurityNotification,
} from '../../src/auth/mfa/mfa-security-notifier';

/**
 * Records MFA security notifications instead of writing emailHistory rows
 * and queueing emails: `recorded` (inside the change's transaction) and
 * `dispatched` (after it committed).
 */
export class FakeMfaNotifier {
  readonly recorded: PendingSecurityNotification[] = [];
  readonly dispatched: PendingSecurityNotification[] = [];

  asNotifier(): MfaSecurityNotifier {
    return this as unknown as MfaSecurityNotifier;
  }

  record(
    _tx: unknown,
    input: { authId: string; event: SecurityNotificationEvent; now: Date },
  ): Promise<PendingSecurityNotification> {
    const pending: PendingSecurityNotification = {
      authId: input.authId,
      historyId: `history-${this.recorded.length + 1}`,
      email: `${input.authId}@example.com`,
      username: input.authId,
      event: input.event,
      occurredAt: input.now.toISOString(),
    };
    this.recorded.push(pending);
    return Promise.resolve(pending);
  }

  dispatch(notification: PendingSecurityNotification): Promise<void> {
    this.dispatched.push(notification);
    return Promise.resolve();
  }

  events(): SecurityNotificationEvent[] {
    return this.dispatched.map((n) => n.event);
  }
}
