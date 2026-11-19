import type { MfaLoginService } from '../../src/auth/mfa/mfa-login.service';

/**
 * The MFA step of sign-in for suites about something else: every user is
 * treated as having MFA disabled (the gate answers NOT_REQUIRED), which is
 * exactly how sign-in behaves for users without MFA.
 */
export function mfaNotRequired(): MfaLoginService {
  return {
    gate: jest.fn().mockResolvedValue({ kind: 'NOT_REQUIRED' }),
    complete: jest.fn().mockRejectedValue(new Error('MFA is not in use')),
  } as unknown as MfaLoginService;
}
