import type { SmsSender } from '../../src/auth/mfa/sms/sms-sender';
import { SmsDeliveryError } from '../../src/auth/mfa/sms/sms-sender';

export interface SentSms {
  to: string;
  body: string;
  /** The six-digit code in the message. */
  code: string;
}

/**
 * A mocked SMS provider: records every message instead of sending it (no
 * external service), and can be told to fail deliveries.
 */
export class CapturingSmsSender implements SmsSender {
  readonly configured = true;
  readonly sent: SentSms[] = [];
  private failures = 0;
  private lostResponses = 0;
  /** Called before each delivery (for example to break something). */
  onSend?: () => void;

  /** The next `count` deliveries fail like an unreachable provider. */
  failNext(count = 1) {
    this.failures += count;
  }

  /**
   * The next message is delivered (the phone receives it) but the
   * provider's answer is lost: the sender sees a failure.
   */
  deliverThenFail() {
    this.lostResponses++;
  }

  send(to: string, body: string): Promise<void> {
    this.onSend?.();
    if (this.failures > 0) {
      this.failures--;
      return Promise.reject(new SmsDeliveryError('SMS provider unreachable'));
    }
    const code = /\b(\d{6})\b/.exec(body)?.[1];
    if (!code) throw new Error(`No code in SMS: ${body}`);
    this.sent.push({ to, body, code });
    if (this.lostResponses > 0) {
      this.lostResponses--;
      return Promise.reject(new SmsDeliveryError('SMS provider timed out'));
    }
    return Promise.resolve();
  }

  /** Messages sent to `to`, oldest first. */
  to(to: string): SentSms[] {
    return this.sent.filter((sms) => sms.to === to);
  }

  /** The code of the latest message sent to `to`. */
  lastCodeTo(to: string): string {
    const messages = this.to(to);
    if (messages.length === 0) throw new Error(`No SMS was sent to ${to}`);
    return messages[messages.length - 1].code;
  }
}
