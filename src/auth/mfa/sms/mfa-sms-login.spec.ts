import { HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { mock } from 'jest-mock-extended';
import type { Logger } from 'winston';
import { FakeMfaNotifier } from '../../../../test/support/fake-mfa-notifier';
import { FakeMfaRepository } from '../../../../test/support/fake-mfa-repository';
import { testCipher } from '../../../../test/support/mfa-test-keys';
import config from '../../../common/config/app.config';
import { ApproveStepUpDto } from '../../step-up/step-up.dto';
import { MfaLoginService } from '../mfa-login.service';
import { totpCode } from '../mfa-totp';
import { MfaVerificationService } from '../mfa-verification.service';
import {
  CompleteMfaLoginDto,
  MfaVerificationDto,
  toMfaLoginFactor,
} from '../mfa.dto';
import { MfaService } from '../mfa.service';
import type { MfaSmsService } from './mfa-sms.service';

const ALICE = 'alice';
const META = { ip: '203.0.113.5', userAgent: 'jest' };
const T0 = new Date(Math.floor(Date.UTC(2026, 10, 28, 9) / 30_000) * 30_000);
const CHALLENGE = `mfac_${'A'.repeat(43)}`;

const errorsOf = <T extends object>(
  type: new () => T,
  body: Record<string, unknown>,
) =>
  validateSync(plainToInstance(type, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
  throw new Error('Expected a rejection');
}

/**
 * SMS codes are a sign-in method only: accepted by POST /auth/login/mfa,
 * refused by step-up and MFA verification, never combined with trusting the
 * device, and offered only to users with a verified number.
 */
describe('MFA SMS at sign-in only', () => {
  describe('requests', () => {
    it('a sign-in takes exactly one of code, recoveryCode or smsCode', () => {
      expect(
        toMfaLoginFactor(
          plainToInstance(CompleteMfaLoginDto, {
            challengeToken: CHALLENGE,
            smsCode: '123456',
          }),
        ),
      ).toEqual({ method: 'sms', code: '123456' });
      for (const body of [
        { smsCode: '123456', code: '123456' },
        { smsCode: '123456', recoveryCode: 'ABCDE-FGHJK' },
        {},
      ]) {
        expect(() =>
          toMfaLoginFactor(
            plainToInstance(CompleteMfaLoginDto, {
              challengeToken: CHALLENGE,
              ...body,
            }),
          ),
        ).toThrow(HttpException);
      }
      expect(
        errorsOf(CompleteMfaLoginDto, {
          challengeToken: CHALLENGE,
          smsCode: '12345',
        }),
      ).toEqual(['smsCode']);
    });

    it.each([
      ['a step-up', ApproveStepUpDto, { action: 'MFA_DISABLE' }],
      ['an MFA verification', MfaVerificationDto, {}],
    ] as const)('%s refuses an SMS code (400)', (_, type, base) => {
      expect(errorsOf(type, { ...base, smsCode: '123456' })).toContain(
        'smsCode',
      );
    });
  });

  describe('MfaLoginService', () => {
    const originalSecret = config.jwt_refresh_secret;
    let repo: FakeMfaRepository;
    let sms: jest.Mocked<Pick<MfaSmsService, 'loginPhone'>>;
    let service: MfaLoginService;
    let enrollment: MfaService;

    beforeAll(() => {
      config.jwt_refresh_secret = '';
    });
    afterAll(() => {
      config.jwt_refresh_secret = originalSecret;
    });

    beforeEach(async () => {
      repo = new FakeMfaRepository();
      repo.addAccount(ALICE);
      const cipher = testCipher();
      const logger = mock<Logger>();
      const notifier = new FakeMfaNotifier().asNotifier();
      enrollment = new MfaService(
        repo.asRepository(),
        cipher,
        notifier,
        logger,
      );
      const verification = new MfaVerificationService(
        repo.asRepository(),
        cipher,
        notifier,
        logger,
      );
      sms = { loginPhone: jest.fn() };
      service = new MfaLoginService(
        repo.asRepository(),
        verification,
        logger,
        sms as unknown as MfaSmsService,
      );
      const { secret } = await enrollment.startEnrollment(ALICE, T0);
      await enrollment.confirmEnrollment(
        ALICE,
        totpCode(secret, T0),
        { ...META },
        T0,
      );
    });

    const gate = () =>
      service.gate(
        { authId: ALICE, provider: 'local', meta: META },
        new Date(T0.getTime() + 60_000),
      );

    it('offers SMS (and shows the masked number) only with a verified number', async () => {
      sms.loginPhone.mockResolvedValue('••••••••23');
      const offered = await gate();
      expect(offered).toMatchObject({
        kind: 'CHALLENGE',
        challenge: {
          methods: ['totp', 'recovery_code', 'sms'],
          smsPhoneNumber: '••••••••23',
        },
      });

      sms.loginPhone.mockResolvedValue(null);
      const plain = await gate();
      expect(plain).toMatchObject({
        challenge: { methods: ['totp', 'recovery_code'] },
      });
      expect((plain as { challenge: object }).challenge).not.toHaveProperty(
        'smsPhoneNumber',
      );
    });

    it('never trusts a device with an SMS code (400, nothing read)', async () => {
      const owner = jest.spyOn(repo.asRepository(), 'loginChallengeOwner');
      const status = await statusOf(
        service.complete(
          {
            challengeToken: CHALLENGE,
            factor: { method: 'sms', code: '123456' },
            trustDevice: true,
            meta: META,
          },
          () => Promise.resolve(null),
        ),
      );
      expect(status).toBe(400);
      expect(owner).not.toHaveBeenCalled();
    });

    it('without the SMS service, sending a code is unavailable (503)', async () => {
      const withoutSms = new MfaLoginService(
        repo.asRepository(),
        {} as MfaVerificationService,
        mock<Logger>(),
      );
      expect(await statusOf(withoutSms.sendSmsCode(CHALLENGE, META))).toBe(503);
    });
  });
});
