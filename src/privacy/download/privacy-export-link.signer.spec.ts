import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import config from '../../common/config/app.config';
import {
  type DownloadLinkClaims,
  DownloadSigningUnavailableError,
  PrivacyExportLinkSigner,
} from './privacy-export-link.signer';

const CLAIMS: DownloadLinkClaims = {
  exportId: 'e3e3e3e3-0000-4000-8000-000000000003',
  authId: '0a0a0a0a-0000-4000-8000-00000000000a',
  archiveSha256: 'a'.repeat(64),
  expires: 1_790_000_000,
};

describe('PrivacyExportLinkSigner (privacy export download links)', () => {
  const originalJwtSecret = config.jwt_access_secret;
  const signer = (values: Record<string, string> = {}) =>
    new PrivacyExportLinkSigner(new ConfigService(values));

  beforeEach(() => {
    config.jwt_access_secret = 'jwt-access-secret-for-signer-spec';
  });
  afterAll(() => {
    config.jwt_access_secret = originalJwtSecret;
  });

  it('produces a 43-character base64url HMAC-SHA256 that verifies', () => {
    const signature = signer().sign(CLAIMS);

    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signer().verify(CLAIMS, signature)).toBe(true);
  });

  it.each([
    ['export', { exportId: 'e3e3e3e3-0000-4000-8000-000000000004' }],
    ['owner', { authId: '0b0b0b0b-0000-4000-8000-00000000000b' }],
    ['archive', { archiveSha256: 'b'.repeat(64) }],
    ['expiry', { expires: CLAIMS.expires + 1 }],
  ])('rejects the signature for a different %s', (_label, change) => {
    const signature = signer().sign(CLAIMS);

    expect(signer().verify({ ...CLAIMS, ...change }, signature)).toBe(false);
  });

  it('rejects tampered, truncated and non-canonical signatures', () => {
    const signature = signer().sign(CLAIMS);
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    // 32 bytes in 43 characters leave the 2 low bits of the last character
    // unused: flipping one gives a different string with the same bytes.
    const alias =
      signature.slice(0, 42) + alphabet[alphabet.indexOf(signature[42]) ^ 1];
    expect(Buffer.from(alias, 'base64url')).toEqual(
      Buffer.from(signature, 'base64url'),
    );

    for (const candidate of [
      flipped,
      signature.slice(0, 42),
      `${signature}A`,
      '',
      alias,
    ]) {
      expect(signer().verify(CLAIMS, candidate)).toBe(false);
    }
  });

  it('uses PRIVACY_EXPORT_DOWNLOAD_SECRET when set, so rotating it revokes issued links', () => {
    const first = signer({ PRIVACY_EXPORT_DOWNLOAD_SECRET: 'x'.repeat(32) });
    const rotated = signer({ PRIVACY_EXPORT_DOWNLOAD_SECRET: 'y'.repeat(32) });
    const signature = first.sign(CLAIMS);

    expect(first.verify(CLAIMS, signature)).toBe(true);
    expect(rotated.verify(CLAIMS, signature)).toBe(false);
    expect(signer().verify(CLAIMS, signature)).toBe(false);
  });

  it('never signs with the JWT access secret itself (derived, purpose-bound key)', () => {
    const canonical = [
      'musecue:privacy-export-download:v1',
      CLAIMS.exportId,
      CLAIMS.authId,
      CLAIMS.archiveSha256,
      String(CLAIMS.expires),
    ].join('\n');
    const withJwtKey = createHmac('sha256', config.jwt_access_secret)
      .update(canonical)
      .digest('base64url');

    expect(signer().sign(CLAIMS)).not.toBe(withJwtKey);
  });

  it('refuses to sign or verify without a usable key', () => {
    expect(() =>
      signer({ PRIVACY_EXPORT_DOWNLOAD_SECRET: 'too-short' }).sign(CLAIMS),
    ).toThrow(DownloadSigningUnavailableError);

    config.jwt_access_secret = '';
    expect(() => signer().sign(CLAIMS)).toThrow(
      DownloadSigningUnavailableError,
    );
    expect(() => signer().verify(CLAIMS, 'A'.repeat(43))).toThrow(
      DownloadSigningUnavailableError,
    );
  });
});
