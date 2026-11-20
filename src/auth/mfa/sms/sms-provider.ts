import { Logger } from '@nestjs/common';

/**
 * Delivery of SMS messages. The application depends only on this
 * interface (token SMS_PROVIDER); tests replace it with a fake.
 */
export interface SmsProvider {
  /** Whether SMS can be sent (a provider is configured). */
  readonly available: boolean;
  /** Sends `body` to `to` (E.164). Throws SmsDeliveryError on failure. */
  send(to: string, body: string): Promise<void>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

/** The message could not be handed to the SMS provider. */
export class SmsDeliveryError extends Error {
  constructor(message = 'The SMS could not be sent') {
    super(message);
    this.name = 'SmsDeliveryError';
  }
}

/** No provider configured: SMS verification is unavailable. */
export class DisabledSmsProvider implements SmsProvider {
  readonly available = false;

  send(): Promise<void> {
    return Promise.reject(new SmsDeliveryError('SMS delivery is disabled'));
  }
}

export interface TwilioSettings {
  accountSid: string;
  authToken: string;
  /** A Twilio phone number (E.164) or a Messaging Service SID (MG...). */
  from: string;
  timeoutMs: number;
}

type Fetch = typeof fetch;

/**
 * Twilio's Messages API over HTTPS (no SDK). Errors never include the
 * message body (it holds a code) or the number.
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly available = true;

  constructor(
    private readonly settings: TwilioSettings,
    private readonly http: Fetch = fetch,
  ) {}

  async send(to: string, body: string): Promise<void> {
    const { accountSid, authToken, from, timeoutMs } = this.settings;
    const form = new URLSearchParams({ To: to, Body: body });
    form.set(from.startsWith('MG') ? 'MessagingServiceSid' : 'From', from);
    let response: Response;
    try {
      response = await this.http(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch {
      throw new SmsDeliveryError('The SMS provider could not be reached');
    }
    if (!response.ok) {
      throw new SmsDeliveryError(
        `The SMS provider refused the message (HTTP ${response.status})`,
      );
    }
  }
}

/**
 * The provider configured by the environment: `SMS_PROVIDER=twilio` with
 * TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM; anything else
 * (default `none`) disables SMS verification.
 */
export function createSmsProvider(env: NodeJS.ProcessEnv): SmsProvider {
  const kind = (env.SMS_PROVIDER ?? 'none').trim().toLowerCase();
  if (kind === 'twilio') {
    const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
    const authToken = env.TWILIO_AUTH_TOKEN?.trim();
    const from = env.TWILIO_FROM?.trim();
    if (accountSid && authToken && from) {
      return new TwilioSmsProvider({
        accountSid,
        authToken,
        from,
        timeoutMs: 10_000,
      });
    }
    new Logger('SmsProvider').warn(
      'SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM: SMS verification is unavailable',
    );
  } else if (kind !== 'none' && kind !== '') {
    new Logger('SmsProvider').warn(
      `Unknown SMS_PROVIDER "${kind}": SMS verification is unavailable`,
    );
  }
  return new DisabledSmsProvider();
}
