import { mock } from 'jest-mock-extended';
import sharp from 'sharp';
import type { Logger } from 'winston';
import { FakeS3CompatibleStorage } from '../../test/support/fake-s3-compatible-storage';
import { detectImageMime } from './image-signature';
import { PrivateImageStorageService } from './private-image-storage.service';
import { PrivateStorageError } from './private-storage.error';

const KEY = 'owner-id/session-id/0b7c9a52-8d2f-4d57-9a8c-0d8c1f0a1b2c.jpg';

const image = (format: 'jpeg' | 'png' | 'webp') =>
  sharp({
    create: { width: 32, height: 32, channels: 3, background: '#336699' },
  })
    .toFormat(format)
    .toBuffer();

describe('Stored image integrity (private cloud storage)', () => {
  describe('detectImageMime', () => {
    it.each(['jpeg', 'png', 'webp'] as const)(
      'recognises real %s data',
      async (format) => {
        expect(detectImageMime(await image(format))).toBe(`image/${format}`);
      },
    );

    it.each([
      [
        'an HTML error page',
        Buffer.from('<html><body>502 Bad Gateway</body></html>'),
      ],
      ['a JSON error body', Buffer.from('{"statusCode":"404"}')],
      ['an empty object', Buffer.alloc(0)],
      ['a truncated JPEG header', Buffer.from([0xff, 0xd8])],
      [
        'a RIFF file that is not WebP',
        Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE'),
      ],
    ])('rejects %s', (_label, bytes) => {
      expect(detectImageMime(bytes)).toBeUndefined();
    });
  });

  describe('PrivateImageStorageService.readImage', () => {
    const logger = mock<Logger>();
    const s3 = new FakeS3CompatibleStorage();
    const storage = new PrivateImageStorageService(
      [s3],
      { activeProvider: 'fake-s3', localRoot: '/unused' },
      logger,
    );
    const ref = { provider: 'fake-s3', key: KEY };

    beforeEach(() => {
      s3.reset();
      jest.clearAllMocks();
    });

    it('returns the stored bytes unchanged when they match the recorded type', async () => {
      const jpeg = await image('jpeg');
      s3.objects.set(KEY, { bytes: jpeg, contentType: 'image/jpeg' });

      await expect(storage.readImage(ref, 'image/jpeg')).resolves.toEqual(jpeg);
    });

    it.each([
      ['a different image type than recorded', () => image('png')],
      [
        'a provider error page',
        () => Promise.resolve(Buffer.from('<html>error</html>')),
      ],
      ['an empty object', () => Promise.resolve(Buffer.alloc(0))],
    ])(
      'refuses %s, logging it without exposing the key',
      async (_label, bytes) => {
        s3.objects.set(KEY, {
          bytes: await bytes(),
          contentType: 'image/jpeg',
        });

        const error = await storage
          .readImage(ref, 'image/jpeg')
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(PrivateStorageError);
        expect(error).toMatchObject({
          code: 'INVALID_PROVIDER_RESPONSE',
          provider: 'fake-s3',
          operation: 'get',
          retryable: false,
        });
        expect(logger.error.mock.calls).toHaveLength(1);
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain(KEY);
      },
    );
  });
});
