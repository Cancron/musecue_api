import {
  SmsDeliveryError,
  type SmsProvider,
} from '../../src/auth/mfa/sms/sms-provider';

export interface SentSms {
  to: string;
  body: string;
  /** The six-digit code in the message. */
  code: string;
}

/**
 * Stands in for the SMS provider (no message leaves the test): records
 * every message, and can fail the next deliveries.
 */
export class FakeSmsProvider implements SmsProvider {
  available = true;
  readonly sent: SentSms[] = [];
  private failures = 0;

  /** The next `count` messages fail (a provider outage). */
  failNext(count = 1) {
    this.failures += count;
  }

  send(to: string, body: string): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new SmsDeliveryError('Fake SMS provider outage'));
    }
    const code = /\b(\d{6})\b/.exec(body)?.[1];
    if (!code) throw new Error('An SMS without a six-digit code');
    this.sent.push({ to, body, code });
    return Promise.resolve();
  }

  /** Messages sent to `to`. */
  to(to: string): SentSms[] {
    return this.sent.filter((sms) => sms.to === to);
  }

  /** The code of the last message sent to `to`. */
  lastCode(to: string): string {
    const messages = this.to(to);
    if (messages.length === 0) throw new Error(`No SMS was sent to ${to}`);
    return messages[messages.length - 1].code;
  }
}
