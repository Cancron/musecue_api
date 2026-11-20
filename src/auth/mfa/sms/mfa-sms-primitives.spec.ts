import { testCipher } from '../../../../test/support/mfa-test-keys';
import { maskPhoneNumber, normalizePhoneNumber } from './mfa-phone-number';
import { generateSmsCode, slidingLimit } from './mfa-sms.service';
import {
  createSmsSender,
  DisabledSmsSender,
  InvalidSmsConfigError,
  SmsDeliveryError,
  TwilioSmsSender,
} from './sms-sender';

const SID = `AC${'0123456789abcdef'.repeat(2)}`;

describe('MFA SMS primitives', () => {
  describe('phone numbers', () => {
    it.each([
      ['+14155550123', '+14155550123'],
      ['+1 (415) 555-0123', '+14155550123'],
      ['+44 7911.123456', '+447911123456'],
    ])('normalizes %p to E.164', (input, e164) => {
      expect(normalizePhoneNumber(input)).toBe(e164);
    });

    it.each([
      '4155550123',
      '+0123456789',
      '+1234',
      '+1415555012345678',
      '+1-800-FLOWERS',
      '',
    ])('refuses %p', (input) => {
      expect(normalizePhoneNumber(input)).toBeNull();
    });

    it('masks all but the last four digits', () => {
      expect(maskPhoneNumber('+14155550123')).toBe('+*******0123');
      expect(maskPhoneNumber('+447911123456')).toBe('+********3456');
    });
  });

  describe('codes', () => {
    it('are six random digits', () => {
      const codes = Array.from({ length: 2000 }, () => generateSmsCode());
      for (const code of codes) expect(code).toMatch(/^\d{6}$/);
      // Not a fixed or short-cycle sequence.
      expect(new Set(codes).size).toBeGreaterThan(1990);
      // Leading zeros are kept.
      const digits = new Set(codes.map((c) => c[0]));
      expect(digits.size).toBe(10);
    });

    it('are hashed with a keyed HMAC (different keys, different hashes)', () => {
      const a = testCipher();
      const b = testCipher();
      expect(a.mac('x')).toMatch(/^[0-9a-f]{64}$/);
      expect(a.mac('x')).toBe(a.mac('x'));
      expect(a.mac('x')).not.toBe(b.mac('x'));
    });
  });

  describe('sliding limits', () => {
    const t = (min: number) => new Date(Date.UTC(2026, 10, 28, 9, min));

    it('allows `max` events per window, then names the time it frees up', () => {
      expect(slidingLimit([], t(0), 3, 15 * 60_000)).toEqual({
        next: [t(0)],
        remaining: 2,
      });
      expect(slidingLimit([t(0), t(1), t(2)], t(3), 3, 15 * 60_000)).toEqual({
        blockedUntil: t(15),
      });
      // Old entries leave the window.
      expect(slidingLimit([t(0), t(1), t(2)], t(15), 3, 15 * 60_000)).toEqual({
        next: [t(1), t(2), t(15)],
        remaining: 0,
      });
    });
  });

  describe('SMS providers', () => {
    it('is disabled by default (and says so)', async () => {
      const sender = createSmsSender({});
      expect(sender).toBeInstanceOf(DisabledSmsSender);
      expect(sender.configured).toBe(false);
      await expect(sender.send('+14155550123', 'x')).rejects.toBeInstanceOf(
        SmsDeliveryError,
      );
    });

    it.each([
      [{ SMS_PROVIDER: 'carrier-pigeon' }],
      [{ SMS_PROVIDER: 'twilio' }],
      [
        {
          SMS_PROVIDER: 'twilio',
          TWILIO_ACCOUNT_SID: SID,
          TWILIO_AUTH_TOKEN: 'token',
        },
      ],
      [
        {
          SMS_PROVIDER: 'twilio',
          TWILIO_ACCOUNT_SID: SID,
          TWILIO_AUTH_TOKEN: 'token',
          TWILIO_FROM_NUMBER: '555-0123',
        },
      ],
    ])('refuses the invalid configuration %p at startup', (env) => {
      expect(() => createSmsSender(env)).toThrow(InvalidSmsConfigError);
    });

    it('sends through Twilio’s Messages API', async () => {
      const fetchImpl = jest.fn(() =>
        Promise.resolve({ ok: true, status: 201 }),
      );
      const sender = new TwilioSmsSender(
        {
          accountSid: SID,
          authToken: 'secret-token',
          from: '+15005550006',
          messagingServiceSid: null,
          timeoutMs: 5000,
        },
        fetchImpl,
      );

      await sender.send('+14155550123', '123456 is your code');

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [
        string,
        { method: string; headers: Record<string, string>; body: string },
      ];
      expect(url).toBe(
        `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
      );
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(
        `Basic ${Buffer.from(`${SID}:secret-token`).toString('base64')}`,
      );
      expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
        To: '+14155550123',
        Body: '123456 is your code',
        From: '+15005550006',
      });
    });

    it('reports refusals and network errors without the number or text', async () => {
      const refused = new TwilioSmsSender(
        {
          accountSid: SID,
          authToken: 't',
          from: null,
          messagingServiceSid: 'MG123',
          timeoutMs: 5000,
        },
        () => Promise.resolve({ ok: false, status: 400 }),
      );
      const error = await refused
        .send('+14155550123', '123456')
        .catch((e: Error) => e);
      expect(error).toBeInstanceOf(SmsDeliveryError);
      expect((error as Error).message).toBe(
        'SMS provider refused the message (400)',
      );
      const unreachable = new TwilioSmsSender(
        {
          accountSid: SID,
          authToken: 't',
          from: '+15005550006',
          messagingServiceSid: null,
          timeoutMs: 5000,
        },
        () => Promise.reject(new TypeError('fetch failed')),
      );
      await expect(unreachable.send('+14155550123', '123456')).rejects.toThrow(
        'SMS provider unreachable (TypeError)',
      );
    });
  });
});
