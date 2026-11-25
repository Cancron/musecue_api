import type { Request } from 'express';
import { MFA_LOGIN } from './mfa.constants';

/**
 * The trusted-device token sent with a sign-in (X-Trusted-Device-Token
 * header), or undefined. Only its hash is ever stored or compared.
 */
export function trustedDeviceTokenOf(req: Request): string | undefined {
  const value = req.headers[MFA_LOGIN.TRUSTED_DEVICE_HEADER];
  const token = Array.isArray(value) ? value[0] : value;
  return token && token.length <= 128 ? token.trim() : undefined;
}
