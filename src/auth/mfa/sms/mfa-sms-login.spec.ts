import { HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { FakeMfaNotifier } from '../../../../test/support/fake-mfa-notifier';
import { FakeMfaRepository } from '../../../../test/support/fake-mfa-repository';
import { testCipher } from '../../../../test/support/mfa-test-keys';
import AppError from '../../../common/errors/app.error';
import { ApproveStepUpDto } from '../../step-up/step-up.dto';
import { MfaLoginService, type MfaChallengeView } from '../mfa-login.service';
import { totpCode } from '../mfa-totp';
import {
  CompleteMfaLoginDto,
  MfaVerificationDto,
  toMfaLoginFactor,
} from '../mfa.dto';
import {
  MfaVerificationService,
  type MfaLoginFactor,
} from '../mfa-verification.service';
import { MfaService } from '../mfa.service';
import type { MfaSmsService } from './mfa-sms.service';

jest.setTimeout(30_000);

const ALICE = 'alice';
const META = { ip: '203.0.113.5', userAgent: 'jest' };
const T0 = new Date(Math.floor(Date.UTC(2026, 10, 28, 9) / 30_000) * 30_000);
const plus = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const TOKEN = `mfac_${'A'.repeat(43)}`;

const errorsOf = <T extends object>(
  cls: new () => T,
  body: Record<string, unknown>,
) =>
  validateSync(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

/**
 * SMS as a factor of the MFA step of sign-in only: the request shapes that
 * accept it (and those that never do), and MfaLoginService's use of
 * MfaSmsService.
 */
describe('MFA SMS at sign-in', () => {
  describe('requests', () => {
    it('only the sign-in MFA step accepts smsCode', () => {
      expect(
        errorsOf(CompleteMfaLoginDto, {
          challengeToken: TOKEN,
          smsCode: '123456',
        }),
      ).toEqual([]);
      expect(
        errorsOf(CompleteMfaLoginDto, {
          challengeToken: TOKEN,
          smsCode: '12345',
        }),
      ).toEqual(['smsCode']);
      // Verification and step-up never accept it.
      expect(errorsOf(MfaVerificationDto, { smsCode: '123456' })).toEqual([
        'smsCode',
      ]);
      expect(
        errorsOf(ApproveStepUpDto, {
          action: 'DATA_EXPORT',
          smsCode: '123456',
        }),
      ).toEqual(['smsCode']);
    });

    it('takes exactly one factor, and an SMS code cannot trust the device', () => {
      const dto = (body: Partial<CompleteMfaLoginDto>) =>
        Object.assign(new CompleteMfaLoginDto(), {
          challengeToken: TOKEN,
          ...body,
        });
      expect(toMfaLoginFactor(dto({ smsCode: '123456' }))).toEqual({
        method: 'sms',
        code: '123456',
      });
      expect(toMfaLoginFactor(dto({ code: '654321' }))).toEqual({
        method: 'totp',
        code: '654321',
      });
      for (const body of [
        {},
        { smsCode: '123456', code: '654321' },
        { smsCode: '123456', recoveryCode: 'ABCDE-FGHJK' },
        { smsCode: '123456', trustDevice: true },
      ]) {
        expect(() => toMfaLoginFactor(dto(body))).toThrow(HttpException);
      }
    });
  });

  describe('MfaLoginService', () => {
    let repo: FakeMfaRepository;
    let sms: ReturnType<typeof mock<MfaSmsService>>;
    let service: MfaLoginService;
    let secret: string;

    beforeEach(async () => {
      repo = new FakeMfaRepository();
      repo.addAccount(ALICE);
      const cipher = testCipher();
      const notifier = new FakeMfaNotifier().asNotifier();
      const logger = mock<Logger>();
      const enrollment = new MfaService(
        repo.asRepository(),
        cipher,
        notifier,
        logger,
      );
      const started = await enrollment.startEnrollment(ALICE, T0);
      secret = started.secret;
      await enrollment.confirmEnrollment(ALICE, totpCode(secret, T0), META, T0);
      sms = mock<MfaSmsService>();
      service = new MfaLoginService(
        repo.asRepository(),
        new MfaVerificationService(
          repo.asRepository(),
          cipher,
          notifier,
          logger,
        ),
        logger,
        sms,
      );
    });

    async function challenge(): Promise<MfaChallengeView> {
      const gate = await service.gate(
        { authId: ALICE, provider: 'local', meta: META },
        plus(MIN),
      );
      if (gate.kind !== 'CHALLENGE') throw new Error('expected a challenge');
      return gate.challenge;
    }

    const complete = (
      view: MfaChallengeView,
      factor: MfaLoginFactor,
      trustDevice = false,
    ) =>
      service.complete(
        {
          challengeToken: view.challengeToken,
          factor,
          trustDevice,
          meta: META,
        },
        () => Promise.resolve('session'),
        plus(2 * MIN),
      );

    it('offers SMS (with the masked number) only when the user can use it', async () => {
      sms.signInPhone.mockResolvedValue(null);
      const without = await challenge();
      expect(without.methods).toEqual(['totp', 'recovery_code']);
      expect(without).not.toHaveProperty('smsPhone');

      sms.signInPhone.mockResolvedValue('+*******0123');
      const withPhone = await challenge();
      expect(withPhone.methods).toEqual(['totp', 'recovery_code', 'sms']);
      expect(withPhone.smsPhone).toBe('+*******0123');
    });

    it('completes the sign-in with a verified SMS code (method sms)', async () => {
      sms.signInPhone.mockResolvedValue('+*******0123');
      sms.checkSignInCode.mockResolvedValue({ kind: 'VERIFIED' });
      const view = await challenge();

      const { completion } = await complete(view, {
        method: 'sms',
        code: '123456',
      });

      expect(completion).toMatchObject({
        authId: ALICE,
        method: 'sms',
        trustedDevice: null,
      });
      const [, authId, challengeId, code] = sms.checkSignInCode.mock.calls[0];
      expect([authId, typeof challengeId, code]).toEqual([
        ALICE,
        'string',
        '123456',
      ]);
      // The challenge is used up.
      await expect(
        complete(view, {
          method: 'totp',
          code: totpCode(secret, plus(2 * MIN)),
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('a declined SMS code leaves the challenge usable', async () => {
      sms.signInPhone.mockResolvedValue('+*******0123');
      sms.checkSignInCode.mockResolvedValue({
        kind: 'INVALID',
        remainingAttempts: 4,
      });
      sms.declinedError.mockReturnValue(
        AppError.badRequest('Invalid SMS code'),
      );
      const view = await challenge();

      await expect(
        complete(view, { method: 'sms', code: '123456' }),
      ).rejects.toMatchObject({ status: 400, message: 'Invalid SMS code' });

      const { completion } = await complete(view, {
        method: 'totp',
        code: totpCode(secret, plus(2 * MIN)),
      });
      expect(completion.method).toBe('totp');
    });

    it('never trusts a device with an SMS code, and never checks the code then', async () => {
      sms.declinedError.mockReturnValue(AppError.conflict('no'));
      const view = await challenge();

      await expect(
        complete(view, { method: 'sms', code: '123456' }, true),
      ).rejects.toMatchObject({ status: 409 });
      expect(sms.checkSignInCode.mock.calls).toHaveLength(0);
    });

    it('without the SMS service, SMS codes are refused', async () => {
      const plain = new MfaLoginService(
        repo.asRepository(),
        new MfaVerificationService(
          repo.asRepository(),
          testCipher(),
          new FakeMfaNotifier().asNotifier(),
          mock<Logger>(),
        ),
        mock<Logger>(),
      );
      const gate = await plain.gate(
        { authId: ALICE, provider: 'local', meta: META },
        plus(MIN),
      );
      if (gate.kind !== 'CHALLENGE') throw new Error('expected a challenge');
      expect(gate.challenge.methods).toEqual(['totp', 'recovery_code']);
      await expect(
        plain.complete(
          {
            challengeToken: gate.challenge.challengeToken,
            factor: { method: 'sms', code: '123456' },
            trustDevice: false,
            meta: META,
          },
          () => Promise.resolve('session'),
          plus(2 * MIN),
        ),
      ).rejects.toMatchObject({ status: 409 });
    });
  });
});
