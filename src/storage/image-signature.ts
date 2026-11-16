import type { SupportedImageMime } from './private-storage-key';

/**
 * Identifies JPEG, PNG and WebP data from its leading signature bytes
 * (no decoding). Returns undefined for anything else, e.g. an HTML error page
 * or a truncated/corrupted object.
 */
export function detectImageMime(bytes: Buffer): SupportedImageMime | undefined {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

export function isSupportedImageMime(
  value: string,
): value is SupportedImageMime {
  return (
    value === 'image/jpeg' || value === 'image/png' || value === 'image/webp'
  );
}
