import { mock } from 'jest-mock-extended';
import type { MfaLoginService } from '../../src/auth/mfa/mfa-login.service';

/**
 * The sign-in MFA gate for tests whose accounts never have MFA enabled:
 * every sign-in proceeds to tokens, exactly as without MFA.
 */
export function noMfaLogin(): MfaLoginService {
  const service = mock<MfaLoginService>();
  service.beginLogin.mockResolvedValue({ kind: 'NOT_REQUIRED' });
  return service;
}
