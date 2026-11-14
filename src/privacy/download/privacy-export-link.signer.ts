import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import config from '../../common/config/app.config';

/** What a download link authorizes; every field is covered by the signature. */
export interface DownloadLinkClaims {
  exportId: string;
  /** The only user who may use the link. */
  authId: string;
  /** SHA-256 of the archive, so a link only ever serves that exact archive. */
  archiveSha256: string;
  /** Link expiry, in whole seconds since the Unix epoch. */
  expires: number;
}

const SIGNATURE_VERSION = 'musecue:privacy-export-download:v1';
const MIN_SECRET_LENGTH = 32;

/** Thrown when no signing key can be established (links are never unsigned). */
export class DownloadSigningUnavailableError extends Error {
  constructor() {
    super('Privacy export download signing is not configured');
    this.name = 'DownloadSigningUnavailableError';
  }
}

/**
 * HMAC-SHA256 signatures for personal-data export download links.
 *
 * The key is PRIVACY_EXPORT_DOWNLOAD_SECRET (at least 32 characters) or,
 * when that is not set, a key derived from the JWT access secret with HKDF
 * under a purpose-specific label, so the JWT key itself never signs links.
 * Verification is constant-time.
 */
@Injectable()
export class PrivacyExportLinkSigner {
  constructor(private readonly configService: ConfigService) {}

  sign(claims: DownloadLinkClaims): string {
    return createHmac('sha256', this.key())
      .update(this.canonical(claims))
      .digest('base64url');
  }

  verify(claims: DownloadLinkClaims, signature: string): boolean {
    const expected = Buffer.from(this.sign(claims), 'base64url');
    const actual = Buffer.from(signature, 'base64url');
    return (
      actual.length === expected.length &&
      // Reject non-canonical encodings that decode to the same bytes.
      actual.toString('base64url') === signature &&
      timingSafeEqual(actual, expected)
    );
  }

  private canonical(claims: DownloadLinkClaims): string {
    return [
      SIGNATURE_VERSION,
      claims.exportId,
      claims.authId,
      claims.archiveSha256,
      String(claims.expires),
    ].join('\n');
  }

  private key(): Buffer {
    const configured = this.configService.get<string>(
      'PRIVACY_EXPORT_DOWNLOAD_SECRET',
    );
    if (configured) {
      if (configured.length < MIN_SECRET_LENGTH) {
        throw new DownloadSigningUnavailableError();
      }
      return Buffer.from(configured, 'utf8');
    }
    if (!config.jwt_access_secret) throw new DownloadSigningUnavailableError();
    return Buffer.from(
      hkdfSync(
        'sha256',
        config.jwt_access_secret,
        Buffer.alloc(0),
        SIGNATURE_VERSION,
        32,
      ),
    );
  }
}
