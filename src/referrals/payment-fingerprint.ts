import { keyedHash, SECRET_PURPOSES } from '../common/security/derived-secrets';

/**
 * The stored form of a payment method: a keyed hash (HMAC-SHA-256 with a
 * purpose-bound key derived from JWT_REFRESH_SECRET) of the provider's
 * payment method fingerprint. The same card or bank account always yields
 * the same hash, so accounts sharing one are recognized, but nothing
 * identifying the payment method (no card number, fingerprint, holder or
 * bank details) is stored, and the hash is useless without the key.
 */
export function hashPaymentFingerprint(
  provider: string,
  fingerprint: string,
): string {
  return keyedHash(
    SECRET_PURPOSES.PAYMENT_FINGERPRINT,
    `${provider}:${fingerprint}`,
  );
}
