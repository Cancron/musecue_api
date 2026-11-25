import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { SECRET_PURPOSES } from '../../common/security/derived-secrets';
import { mfaKey } from './mfa-keys';
import { generateRecoveryCodes, normalizeRecoveryCode } from './recovery-codes';

/** A new set: the codes to show once, and the hashes to store. */
export interface IssuedRecoveryCodes {
  codes: string[];
  hashes: string[];
}

/**
 * Hashes MFA recovery codes for storage and lookup: HMAC-SHA-256 under a key
 * derived from MFA_ENCRYPTION_KEY only (never the JWT secrets), over the user
 * ID and the normalized code. The key is
 * not in the database, so stored hashes cannot be brute-forced from a
 * database copy; binding the user means a code only ever matches for the
 * account it was issued to. Codes have 60 random bits, so a keyed hash (not a
 * slow password hash) is sufficient and allows an indexed lookup.
 */
@Injectable()
export class MfaRecoveryCodeHasher {
  constructor(private readonly configService: ConfigService) {}

  /** A new set of recovery codes for `authId`. */
  issue(authId: string): IssuedRecoveryCodes {
    const codes = generateRecoveryCodes();
    return {
      codes,
      hashes: codes.map((code) => this.hash(authId, code) as string),
    };
  }

  /** The stored hash of a code (any accepted input form), or null if it cannot be a code. */
  hash(authId: string, code: string): string | null {
    const normalized = normalizeRecoveryCode(code);
    if (normalized === null) return null;
    return createHmac(
      'sha256',
      mfaKey(this.configService, SECRET_PURPOSES.MFA_RECOVERY_CODE),
    )
      .update(`${authId}\u0000${normalized}`, 'utf8')
      .digest('hex');
  }
}
