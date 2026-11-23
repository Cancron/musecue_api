import type { SendMailOptions } from 'nodemailer';
import type { SentEmail } from './infrastructure-flows';

/** One message the mock SMTP server accepted. */
export interface MockSmtpMessage {
  to: string;
  subject: string;
  html: string;
  acceptedAt: Date;
}

/** An SMTP failure like nodemailer reports it (e.g. 421 service unavailable). */
export class MockSmtpError extends Error {
  constructor(
    readonly responseCode: number,
    message: string,
    readonly code = 'EENVELOPE',
  ) {
    super(message);
    this.name = 'SMTPError';
  }
}

/**
 * A mock SMTP transport for EmailService (EMAIL_TRANSPORT): the real email
 * templates are rendered and "delivered" here, never sent. Failures can be
 * injected for the next messages, for some recipients, or until further
 * notice (an SMTP outage).
 */
export class MockSmtpTransport {
  readonly delivered: MockSmtpMessage[] = [];
  /** Every attempt, including failed ones. */
  readonly attempts: Array<{ to: string; subject: string; ok: boolean }> = [];
  private failuresLeft = 0;
  private outage = false;
  private readonly failingRecipients = new Map<string, number>();

  /** The next `count` messages fail with a transient SMTP error. */
  failNext(count = 1) {
    this.failuresLeft += count;
  }

  /** Messages to `to` fail `count` times (default: until cleared). */
  failFor(to: string, count = Number.POSITIVE_INFINITY) {
    this.failingRecipients.set(to, count);
  }

  /** Every message fails until `outage(false)`. */
  setOutage(down: boolean) {
    this.outage = down;
  }

  reset() {
    this.failuresLeft = 0;
    this.outage = false;
    this.failingRecipients.clear();
  }

  sendMail(options: SendMailOptions): Promise<{ messageId: string }> {
    const to =
      typeof options.to === 'string' ? options.to : JSON.stringify(options.to);
    const subject = String(options.subject ?? '');
    const recipientFailures = this.failingRecipients.get(to) ?? 0;
    const fail = this.outage || this.failuresLeft > 0 || recipientFailures > 0;
    this.attempts.push({ to, subject, ok: !fail });
    if (fail) {
      if (this.failuresLeft > 0) this.failuresLeft -= 1;
      if (recipientFailures > 0) {
        this.failingRecipients.set(to, recipientFailures - 1);
      }
      return Promise.reject(
        new MockSmtpError(
          421,
          '421 4.3.0 Service not available, try again later',
        ),
      );
    }
    this.delivered.push({
      to,
      subject,
      html: typeof options.html === 'string' ? options.html : '',
      acceptedAt: new Date(),
    });
    return Promise.resolve({
      messageId: `<mock-${this.delivered.length}@smtp.test>`,
    });
  }

  /** Delivered messages to one recipient. */
  to(address: string): MockSmtpMessage[] {
    return this.delivered.filter((message) => message.to === address);
  }
}

const SUBJECT_KINDS: Record<string, SentEmail['kind']> = {
  'Verify your MuseCue email address': 'verification',
  'Welcome to MuseCue!': 'welcome',
  'Confirm the deletion of your MuseCue account': 'account-deletion-code',
};

/**
 * The captured-email view of the mock SMTP server (what
 * CapturingEmailService records), for the shared test flows.
 */
export class SmtpEmailCapture {
  constructor(private readonly smtp: MockSmtpTransport) {}

  get sent(): SentEmail[] {
    return this.smtp.delivered.map((message) => {
      const kind = SUBJECT_KINDS[message.subject] ?? 'notification';
      const code =
        /class="code">([A-Za-z0-9]+)</.exec(message.html)?.[1] ?? undefined;
      return {
        kind,
        to: message.to,
        ...(code && kind !== 'notification' ? { code } : {}),
        subject: message.subject,
      };
    });
  }
}
