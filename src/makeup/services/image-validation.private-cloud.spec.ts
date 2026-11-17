import sharp from 'sharp';
import AppError from '../../common/errors/app.error';
import { ImageValidationService } from './image-validation.service';

const validation = new ImageValidationService();
const file = (buffer: Buffer) =>
  ({ buffer, size: buffer.length }) as Express.Multer.File;

/**
 * Noise from a fixed seed, so every run encodes the same image. (sharp's
 * generated noise differs per run; with some random images the corrupted JPEG
 * below happened to decode, which made the test fail about once in 150 runs.)
 */
function noisePixels(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 0x2f6b1c3d;
  for (let index = 0; index < pixels.length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[index] = seed >>> 24;
  }
  return pixels;
}

const noisy = (format: 'jpeg' | 'png' | 'webp') =>
  sharp(noisePixels(800, 600), {
    raw: { width: 800, height: 600, channels: 3 },
  })
    .toFormat(format)
    .toBuffer();

describe('Upload validation rejects undecodable images (private images)', () => {
  it.each(['jpeg', 'png', 'webp'] as const)(
    'accepts a valid %s and derives its metadata',
    async (format) => {
      await expect(
        validation.validate(file(await noisy(format))),
      ).resolves.toEqual(
        expect.objectContaining({
          mimeType: `image/${format}`,
          width: 800,
          height: 600,
        }),
      );
    },
  );

  it.each([
    ['a JPEG truncated at 60%', 'jpeg', 0.6],
    ['a JPEG missing only its last 1%', 'jpeg', 0.99],
    ['a JPEG truncated at 5%', 'jpeg', 0.05],
    ['a PNG truncated at 50%', 'png', 0.5],
  ] as const)(
    'rejects %s even though its headers still parse',
    async (_label, format, keep) => {
      const full = await noisy(format);
      const truncated = full.subarray(0, Math.floor(full.length * keep));
      await expect(sharp(truncated).metadata()).resolves.toMatchObject({
        format,
        width: 800,
        height: 600,
      });

      const error = await validation
        .validate(file(truncated))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).getStatus()).toBe(400);
      expect((error as AppError).getResponse()).toMatchObject({
        message: 'The uploaded file is not a readable image',
      });
    },
  );

  it('rejects a JPEG whose header is valid but whose pixel data is garbage', async () => {
    const valid = await noisy('jpeg');
    const corrupted = Buffer.concat([
      valid.subarray(0, 600),
      Buffer.alloc(valid.length - 600, 0x5a),
    ]);

    await expect(validation.validate(file(corrupted))).rejects.toMatchObject({
      status: 400,
    });
  });
});
