import { HttpException } from '@nestjs/common';
import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { FakeMfaNotifier } from '../../../../test/support/fake-mfa-notifier';
import { FakeSmsRepository } from '../../../../test/support/fake-sms-repository';
import { CapturingSmsSender } from '../../../../test/support/fake-sms';
import { testCipher } from '../../../../test/support/mfa-test-keys';
import { hashMfaToken } from '../mfa-login.service';
import type { MfaSecretCipher } from '../mfa-secret.cipher';
import { MfaSmsService } from './mfa-sms.service';
import { DisabledSmsSender } from './sms-sender';

const ALICE = 'alice';
const BOB = 'bob';
const PHONE = '+14155550123';
const NEW_PHONE = '+447911123456';
const META = { ip: '203.0.113.9', userAgent: 'jest' };
const T0 = new Date('2026-11-28T09:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);
const CHANGE = {
  metadata: META,
  sessionId: 'session-1',
  approvedWith: 'TOTP' as const,
};
const TOKEN = `mfac_${'A'.repeat(43)}`;

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), message: error.message };
  }
  throw new Error('Expected a rejection');
}

/**
 * MfaSmsService against an in-memory repository, a mocked SMS provider and
 * a real cipher: phone enrollment, replacement and removal, sign-in codes,
 * single use, expiry, and the delivery and verification limits.
 */
describe('MFA SMS verification (MfaSmsService)', () => {
  let repo: FakeSmsRepository;
  let sms: CapturingSmsSender;
  let notifier: FakeMfaNotifier;
  let cipher: MfaSecretCipher;
  let service: MfaSmsService;

  beforeEach(() => {
    repo = new FakeSmsRepository();
    repo.addAccount(ALICE);
    repo.addAccount(BOB);
    sms = new CapturingSmsSender();
    notifier = new FakeMfaNotifier();
    cipher = testCipher();
    service = new MfaSmsService(
      repo.asRepository(),
      cipher,
      notifier.asNotifier(),
      sms,
      mock<Logger>(),
    );
  });

  /** Alice with a verified phone at T0. */
  async function enrolled(number = PHONE) {
    await service.startPhoneVerification(ALICE, 'enrollment', number, {}, T0);
    await service.confirmPhoneVerification(
      ALICE,
      'enrollment',
      sms.lastCodeTo(number),
      CHANGE,
      T0,
    );
  }

  /** A sign-in challenge of `authId`, and an SMS code sent for it. */
  async function signInCode(authId: string, now: Date, token = TOKEN) {
    const challengeId = repo.addChallenge(
      authId,
      hashMfaToken(token),
      at(10 * MIN + now.getTime() - T0.getTime()),
    );
    await service.sendSignInCode(token, META, now);
    return { challengeId, code: sms.lastCodeTo(PHONE) };
  }

  const check = (
    code: string,
    challengeId: string,
    now: Date,
    authId = ALICE,
  ) =>
    service.checkSignInCode({} as never, authId, challengeId, code, META, now);

  describe('phone enrollment', () => {
    it('sends a random six-digit code to the E.164 number and stores only its HMAC', async () => {
      const sent = await service.startPhoneVerification(
        ALICE,
        'enrollment',
        '+1 (415) 555-0123',
        {},
        T0,
      );

      expect(sent).toEqual({
        purpose: 'enrollment',
        maskedNumber: '+*******0123',
        expiresAt: at(5 * MIN),
        deliveriesRemaining: 2,
      });
      const [message] = sms.sent;
      expect(message.to).toBe(PHONE);
      expect(message.code).toMatch(/^\d{6}$/);
      const [row] = repo.codes;
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.codeHash).not.toContain(message.code);
      expect(row.destination).toMatch(/^mfa2\./);
      expect(cipher.decrypt('phone', ALICE, row.destination!)).toBe(PHONE);
      // Bound to its user: another user's key material cannot read it.
      expect(() => cipher.decrypt('phone', BOB, row.destination!)).toThrow();
    });

    it('confirms the number with the code: stored encrypted, masked, recorded and announced', async () => {
      await enrolled();

      const phone = repo.phones.get(ALICE)!;
      expect(phone.maskedNumber).toBe('+*******0123');
      expect(phone.verifiedAt).toEqual(T0);
      expect(cipher.decrypt('phone', ALICE, phone.phoneNumber)).toBe(PHONE);
      expect(repo.events.map((e) => e.type)).toEqual([
        'MFA_SMS_CODE_SENT',
        'MFA_SMS_ENABLED',
      ]);
      expect(repo.audits).toEqual([
        { authId: ALICE, fields: ['mfaSmsPhone', 'stepUpMethod'] },
      ]);
      expect(notifier.events()).toEqual(['MFA_SMS_ENABLED']);
      expect(await service.status(ALICE, T0)).toEqual({
        available: true,
        enabled: true,
        phone: { maskedNumber: '+*******0123', verifiedAt: T0 },
        pending: null,
      });
    });

    it('is refused without authenticator MFA, for invalid numbers and when a number exists', async () => {
      repo.addAccount('carol', false);
      expect(
        await rejection(
          service.startPhoneVerification('carol', 'enrollment', PHONE, {}, T0),
        ),
      ).toMatchObject({ status: 409 });
      expect(
        await rejection(
          service.startPhoneVerification(ALICE, 'enrollment', '0123', {}, T0),
        ),
      ).toMatchObject({ status: 400 });
      await enrolled();
      expect(
        await rejection(
          service.startPhoneVerification(
            ALICE,
            'enrollment',
            NEW_PHONE,
            {},
            T0,
          ),
        ),
      ).toMatchObject({ status: 409 });
      expect(sms.sent).toHaveLength(1);
    });

    it('refuses wrong and expired codes, and a superseded code', async () => {
      await service.startPhoneVerification(ALICE, 'enrollment', PHONE, {}, T0);
      const first = sms.lastCodeTo(PHONE);
      const wrong = String((Number(first) + 1) % 1_000_000).padStart(6, '0');

      expect(
        await rejection(
          service.confirmPhoneVerification(
            ALICE,
            'enrollment',
            wrong,
            CHANGE,
            T0,
          ),
        ),
      ).toEqual({
        status: 400,
        message: 'Invalid or expired SMS code. 4 attempt(s) remaining.',
      });
      expect(
        await rejection(
          service.confirmPhoneVerification(
            ALICE,
            'enrollment',
            first,
            CHANGE,
            at(5 * MIN),
          ),
        ),
      ).toMatchObject({ status: 400 });
      await service.startPhoneVerification(
        ALICE,
        'enrollment',
        PHONE,
        {},
        at(6 * MIN),
      );
      const second = sms.lastCodeTo(PHONE);
      if (second !== first) {
        expect(
          await rejection(
            service.confirmPhoneVerification(
              ALICE,
              'enrollment',
              first,
              CHANGE,
              at(6 * MIN),
            ),
          ),
        ).toMatchObject({ status: 400 });
      }
      await service.confirmPhoneVerification(
        ALICE,
        'enrollment',
        second,
        CHANGE,
        at(6 * MIN),
      );
      expect(repo.phones.has(ALICE)).toBe(true);
    });
  });

  describe('replacing and removing the number', () => {
    it('replacement keeps the old number until confirmed, then ends every open code', async () => {
      await enrolled();
      const { challengeId, code } = await signInCode(ALICE, at(MIN));
      await service.startPhoneVerification(
        ALICE,
        'replacement',
        NEW_PHONE,
        {},
        at(MIN),
      );
      // Still the old number.
      expect(repo.phones.get(ALICE)!.maskedNumber).toBe('+*******0123');

      await service.confirmPhoneVerification(
        ALICE,
        'replacement',
        sms.lastCodeTo(NEW_PHONE),
        CHANGE,
        at(2 * MIN),
      );

      expect(repo.phones.get(ALICE)!.maskedNumber).toBe('+********3456');
      expect(await check(code, challengeId, at(2 * MIN))).toMatchObject({
        kind: 'INVALID',
      });
      expect(repo.codesOf(ALICE, 'SIGN_IN')[0].invalidatedAt).toEqual(
        at(2 * MIN),
      );
      expect(notifier.events()).toEqual([
        'MFA_SMS_ENABLED',
        'MFA_SMS_PHONE_REPLACED',
      ]);
    });

    it('refuses replacing with the same number or without a number', async () => {
      expect(
        await rejection(
          service.startPhoneVerification(ALICE, 'replacement', PHONE, {}, T0),
        ),
      ).toMatchObject({
        status: 409,
        message: 'No phone number is registered',
      });
      await enrolled();
      expect(
        await rejection(
          service.startPhoneVerification(ALICE, 'replacement', PHONE, {}, T0),
        ),
      ).toMatchObject({ status: 409 });
    });

    it('removal deletes the number and ends every code', async () => {
      await enrolled();
      const { challengeId, code } = await signInCode(ALICE, at(MIN));

      await service.removePhone(ALICE, CHANGE, at(2 * MIN));

      expect(repo.phones.has(ALICE)).toBe(false);
      expect(await check(code, challengeId, at(2 * MIN))).toEqual({
        kind: 'NOT_AVAILABLE',
      });
      expect(
        repo.codesOf(ALICE).filter((c) => !c.usedAt && !c.invalidatedAt),
      ).toEqual([]);
      expect(
        await rejection(service.removePhone(ALICE, CHANGE, at(3 * MIN))),
      ).toMatchObject({ status: 409 });
    });
  });

  describe('sign-in codes', () => {
    it('a code of the challenge verifies once', async () => {
      await enrolled();
      const { challengeId, code } = await signInCode(ALICE, at(MIN));

      expect(await check(code, challengeId, at(2 * MIN))).toEqual({
        kind: 'VERIFIED',
      });
      expect(await check(code, challengeId, at(2 * MIN))).toMatchObject({
        kind: 'INVALID',
      });
    });

    it('refuses expired codes, other challenges’ codes, resent codes and other users', async () => {
      await enrolled();
      const first = await signInCode(ALICE, at(MIN));
      // Resent: the first code of the challenge ends.
      await service.sendSignInCode(TOKEN, META, at(MIN + 1000));
      const second = sms.lastCodeTo(PHONE);

      if (second !== first.code) {
        expect(
          await check(first.code, first.challengeId, at(2 * MIN)),
        ).toMatchObject({ kind: 'INVALID' });
      }
      expect(
        await check(second, 'another-challenge', at(2 * MIN)),
      ).toMatchObject({ kind: 'INVALID' });
      expect(await check(second, first.challengeId, at(2 * MIN), BOB)).toEqual({
        kind: 'NOT_AVAILABLE',
      }); // Bob has no phone
      expect(
        await check(second, first.challengeId, at(MIN + 1000 + 5 * MIN)),
      ).toMatchObject({ kind: 'INVALID' }); // expired
    });

    it('needs a valid challenge, authenticator MFA and a number', async () => {
      expect(
        await rejection(service.sendSignInCode(TOKEN, META, T0)),
      ).toMatchObject({ status: 401 });
      repo.addChallenge(ALICE, hashMfaToken(TOKEN), at(5 * MIN));
      expect(
        await rejection(service.sendSignInCode(TOKEN, META, T0)),
      ).toMatchObject({ status: 409 });
      expect(
        await rejection(service.sendSignInCode(TOKEN, META, at(5 * MIN))),
      ).toMatchObject({ status: 401 }); // expired challenge
      expect(sms.sent).toEqual([]);
    });
  });

  describe('limits', () => {
    it('sends at most 3 codes within 15 minutes (all purposes together)', async () => {
      await enrolled(); // 1
      repo.addChallenge(ALICE, hashMfaToken(TOKEN), at(30 * MIN));
      await service.sendSignInCode(TOKEN, META, at(MIN)); // 2
      await service.sendSignInCode(TOKEN, META, at(2 * MIN)); // 3

      expect(
        await rejection(service.sendSignInCode(TOKEN, META, at(3 * MIN))),
      ).toEqual({
        status: 429,
        message: `Too many SMS codes were sent. Try again after ${at(15 * MIN).toISOString()}.`,
      });
      expect(sms.sent).toHaveLength(3);
      // The earlier codes of the challenge were not ended by the refusal.
      expect(
        repo.codesOf(ALICE, 'SIGN_IN').filter((c) => !c.invalidatedAt),
      ).toHaveLength(1);
      // The window slides.
      await service.sendSignInCode(TOKEN, META, at(15 * MIN));
      expect(sms.sent).toHaveLength(4);
    });

    it('checks at most 5 codes within 15 minutes, counting correct ones too', async () => {
      await enrolled(); // check 1 (the confirmation)
      const { challengeId, code } = await signInCode(ALICE, at(MIN));
      const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
      const remaining: (number | false)[] = [];
      for (let i = 0; i < 4; i++) {
        const outcome = await check(wrong, challengeId, at(MIN));
        remaining.push(outcome.kind === 'INVALID' && outcome.remainingAttempts);
      }
      expect(remaining).toEqual([3, 2, 1, 0]);

      expect(await check(code, challengeId, at(MIN))).toEqual({
        kind: 'BLOCKED',
        until: at(15 * MIN),
      });
      // Not counted while refused; free again once the window slid (a new
      // code: the first one has expired by then).
      const later = `mfac_${'B'.repeat(43)}`;
      const laterChallenge = repo.addChallenge(
        ALICE,
        hashMfaToken(later),
        at(20 * MIN),
      );
      await service.sendSignInCode(later, META, at(15 * MIN));
      expect(
        await check(sms.lastCodeTo(PHONE), laterChallenge, at(15 * MIN)),
      ).toEqual({ kind: 'VERIFIED' });
    });

    it('a failed delivery ends its code and does not count (503)', async () => {
      sms.failNext();
      expect(
        await rejection(
          service.startPhoneVerification(ALICE, 'enrollment', PHONE, {}, T0),
        ),
      ).toMatchObject({ status: 503 });
      expect(repo.accounts.get(ALICE)!.deliveriesAt).toEqual([]);
      expect(repo.codes[0].invalidatedAt).toEqual(T0);
    });

    it('a code whose delivery failed stays unusable even when ending it fails', async () => {
      await enrolled();
      repo.addChallenge(ALICE, hashMfaToken(TOKEN), at(10 * MIN));
      const challengeId = repo.challenges.get(hashMfaToken(TOKEN))!.id;
      // The phone receives the message, the provider's answer is lost, and
      // the database cannot end the code afterwards.
      sms.deliverThenFail();
      sms.onSend = () => {
        repo.failLocksAfter = 0;
      };

      expect(
        await rejection(service.sendSignInCode(TOKEN, META, at(MIN))),
      ).toMatchObject({ status: 503 });

      sms.onSend = undefined;
      repo.failLocksAfter = null;
      const [code] = repo.codesOf(ALICE, 'SIGN_IN');
      expect(code).toMatchObject({ deliveredAt: null, invalidatedAt: null });
      expect(
        await check(sms.lastCodeTo(PHONE), challengeId, at(2 * MIN)),
      ).toMatchObject({ kind: 'INVALID' });
      expect(code.usedAt).toBeNull();
    });

    it('a sent code is unusable when its delivery cannot be recorded (503, still counted)', async () => {
      await enrolled();
      repo.addChallenge(ALICE, hashMfaToken(TOKEN), at(10 * MIN));
      const challengeId = repo.challenges.get(hashMfaToken(TOKEN))!.id;
      repo.failMarkDelivered = true;

      expect(
        await rejection(service.sendSignInCode(TOKEN, META, at(MIN))),
      ).toMatchObject({ status: 503 });

      repo.failMarkDelivered = false;
      expect(
        await check(sms.lastCodeTo(PHONE), challengeId, at(2 * MIN)),
      ).toMatchObject({ kind: 'INVALID' });
      const [code] = repo.codesOf(ALICE, 'SIGN_IN');
      expect(code.invalidatedAt).toEqual(at(MIN));
      // A message went out: it counts toward the limit.
      expect(repo.accounts.get(ALICE)!.deliveriesAt).toHaveLength(2);
    });

    it('without a configured provider, nothing is sent (503)', async () => {
      service = new MfaSmsService(
        repo.asRepository(),
        cipher,
        notifier.asNotifier(),
        new DisabledSmsSender(),
        mock<Logger>(),
      );
      expect(
        await rejection(
          service.startPhoneVerification(ALICE, 'enrollment', PHONE, {}, T0),
        ),
      ).toMatchObject({ status: 503 });
      expect(repo.codes).toEqual([]);
      expect((await service.status(ALICE)).available).toBe(false);
    });
  });
});
