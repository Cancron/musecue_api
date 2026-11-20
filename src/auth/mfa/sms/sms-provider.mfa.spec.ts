import {
  createSmsProvider,
  DisabledSmsProvider,
  SmsDeliveryError,
  TwilioSmsProvider,
} from './sms-provider';

/** The SMS provider behind MFA SMS codes (no real request is made). */
describe('SMS provider (MFA SMS codes)', () => {
  const settings = {
    accountSid: 'AC123',
    authToken: 'secret-token',
    from: '+15005550006',
    timeoutMs: 1000,
  };
  const body = 'Your MuseCue sign-in code is 123456.';

  it('sends through Twilio’s Messages API with basic authentication', async () => {
    const http = jest.fn(() =>
      Promise.resolve(new Response('{}', { status: 201 })),
    );
    await new TwilioSmsProvider(settings, http).send('+14155550123', body);

    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json',
    );
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('AC123:secret-token').toString('base64')}`,
    );
    expect(
      Object.fromEntries(new URLSearchParams(init.body as string)),
    ).toEqual({ To: '+14155550123', From: '+15005550006', Body: body });
  });

  it('uses a Messaging Service when TWILIO_FROM is one', async () => {
    const http = jest.fn(() =>
      Promise.resolve(new Response('{}', { status: 201 })),
    );
    await new TwilioSmsProvider({ ...settings, from: 'MG999' }, http).send(
      '+14155550123',
      body,
    );
    const [, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect(
      new URLSearchParams(init.body as string).get('MessagingServiceSid'),
    ).toBe('MG999');
  });

  it.each([
    ['a refusal', () => Promise.resolve(new Response('{}', { status: 400 }))],
    ['a network error', () => Promise.reject(new Error('ECONNRESET'))],
  ])(
    'reports %s as SmsDeliveryError, never with the number or the code',
    async (_, response) => {
      const provider = new TwilioSmsProvider(settings, jest.fn(response));
      const error = await provider.send('+14155550123', body).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SmsDeliveryError);
      expect((error as Error).message).not.toMatch(/4155550123|123456/);
    },
  );

  it('is disabled unless configured', async () => {
    expect(createSmsProvider({})).toBeInstanceOf(DisabledSmsProvider);
    expect(createSmsProvider({ SMS_PROVIDER: 'twilio' }).available).toBe(false);
    expect(
      createSmsProvider({ SMS_PROVIDER: 'carrier-pigeon' }).available,
    ).toBe(false);
    await expect(new DisabledSmsProvider().send()).rejects.toBeInstanceOf(
      SmsDeliveryError,
    );
    const twilio = createSmsProvider({
      SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_AUTH_TOKEN: 't',
      TWILIO_FROM: '+15005550006',
    });
    expect(twilio).toBeInstanceOf(TwilioSmsProvider);
    expect(twilio.available).toBe(true);
  });
});
