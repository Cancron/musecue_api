/**
 * Delivery of SMS messages (MFA codes). The provider is chosen with
 * SMS_PROVIDER: `disabled` (default: SMS features answer 503) or `twilio`
 * (Twilio's Messages API). Tests replace SMS_SENDER with a mock; no code is
 * ever logged.
 */
export const SMS_SENDER = Symbol('SMS_SENDER');

export interface SmsSender {
  /** Whether messages can be sent at all. */
  readonly configured: boolean;
  /** Sends `body` to the E.164 number `to`; throws SmsDeliveryError. */
  send(to: string, body: string): Promise<void>;
}

/** The message could not be handed to the provider (no number or text in it). */
export class SmsDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsDeliveryError';
  }
}

/** An invalid SMS configuration stops the application at startup. */
export class InvalidSmsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSmsConfigError';
  }
}

export class DisabledSmsSender implements SmsSender {
  readonly configured = false;

  send(): Promise<void> {
    return Promise.reject(
      new SmsDeliveryError('SMS delivery is not configured'),
    );
  }
}

export interface TwilioSmsConfig {
  accountSid: string;
  authToken: string;
  /** Sender: a Twilio phone number (E.164)... */
  from: string | null;
  /** ...or a Messaging Service SID. */
  messagingServiceSid: string | null;
  /** Request timeout. */
  timeoutMs: number;
}

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

/** Twilio Programmable Messaging (POST .../Messages.json). */
export class TwilioSmsSender implements SmsSender {
  readonly configured = true;

  constructor(
    private readonly config: TwilioSmsConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async send(to: string, body: string): Promise<void> {
    const form = new URLSearchParams({ To: to, Body: body });
    if (this.config.messagingServiceSid) {
      form.set('MessagingServiceSid', this.config.messagingServiceSid);
    } else if (this.config.from) {
      form.set('From', this.config.from);
    }
    const credentials = Buffer.from(
      `${this.config.accountSid}:${this.config.authToken}`,
    ).toString('base64');
    let status: number;
    try {
      const response = await this.fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        },
      );
      if (response.ok) return;
      status = response.status;
    } catch (error) {
      throw new SmsDeliveryError(
        `SMS provider unreachable (${error instanceof Error ? error.name : 'error'})`,
      );
    }
    throw new SmsDeliveryError(`SMS provider refused the message (${status})`);
  }
}

/** The sender configured in the environment. */
export function createSmsSender(
  env: Record<string, string | undefined> = process.env,
): SmsSender {
  const provider = (env.SMS_PROVIDER ?? 'disabled').trim().toLowerCase();
  if (provider === '' || provider === 'disabled') {
    return new DisabledSmsSender();
  }
  if (provider !== 'twilio') {
    throw new InvalidSmsConfigError(
      'SMS_PROVIDER must be "disabled" or "twilio"',
    );
  }
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() ?? '';
  const authToken = env.TWILIO_AUTH_TOKEN?.trim() ?? '';
  const from = env.TWILIO_FROM_NUMBER?.trim() || null;
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID?.trim() || null;
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid) || !authToken) {
    throw new InvalidSmsConfigError(
      'SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID (AC...) and TWILIO_AUTH_TOKEN',
    );
  }
  if (!from && !messagingServiceSid) {
    throw new InvalidSmsConfigError(
      'SMS_PROVIDER=twilio needs TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID',
    );
  }
  if (from && !/^\+[1-9]\d{7,14}$/.test(from)) {
    throw new InvalidSmsConfigError(
      'TWILIO_FROM_NUMBER must be an E.164 number',
    );
  }
  const timeoutMs = Number(env.SMS_TIMEOUT_MS ?? 10_000);
  return new TwilioSmsSender({
    accountSid,
    authToken,
    from,
    messagingServiceSid,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000,
  });
}
