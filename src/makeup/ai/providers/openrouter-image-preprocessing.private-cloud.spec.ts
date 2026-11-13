import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { AiProviderError } from '../ai-provider.error';
import { OpenRouterProvider } from './openrouter.provider';
import type { StructuredGenerationRequest } from './structured-ai.provider';

type Image = NonNullable<StructuredGenerationRequest['image']>;

function okResponse() {
  return new Response(
    JSON.stringify({
      id: 'generation-id',
      model: 'vision-model',
      choices: [{ message: { content: '{"answer":"ok"}' } }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function provider(env: Record<string, string> = {}) {
  return new OpenRouterProvider(
    new ConfigService({
      OPENROUTER_API_KEY: 'sk-or-v1-fake-test-key',
      OPENROUTER_MODEL: 'vision/model',
      ...env,
    }),
  );
}

function request(image: Image): StructuredGenerationRequest {
  return {
    operation: 'VISION_CHECK',
    schemaName: 'check',
    schema: { type: 'object' },
    systemInstruction: 'system',
    taskInstruction: 'task',
    userContext: { step: 1 },
    image,
  };
}

/** Sends the image and returns the bytes OpenRouter actually received. */
async function sentImage(image: Image, env?: Record<string, string>) {
  const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse());
  await provider(env).generateStructured(request(image));
  const body = fetchSpy.mock.calls[0]?.[1]?.body as string;
  const match = /"url":"data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)"/.exec(
    body,
  );
  expect(match).not.toBeNull();
  const bytes = Buffer.from(match?.[2] ?? '', 'base64');
  return {
    body,
    mimeType: match?.[1],
    bytes,
    meta: await sharp(bytes).metadata(),
  };
}

const photo = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 190, g: 140, b: 120 },
    },
  });

describe('OpenRouter image preprocessing (private images)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('strips all metadata (location, device) even from small photos', async () => {
    const withExif = await photo(640, 480)
      .withExif({
        IFD0: { Make: 'PhoneMaker', Model: 'Phone 15 Pro' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' },
      })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const sent = await sentImage({ bytes: withExif, mimeType: 'image/jpeg' });

    expect(sent.mimeType).toBe('image/jpeg');
    expect(sent.meta.exif).toBeUndefined();
    expect(sent.meta.xmp).toBeUndefined();
    expect(sent.bytes.includes(Buffer.from('PhoneMaker'))).toBe(false);
  });

  it('turns the photo upright using its EXIF orientation before stripping it', async () => {
    const sideways = await photo(600, 400)
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const sent = await sentImage({ bytes: sideways, mimeType: 'image/jpeg' });

    expect(sent.meta).toMatchObject({ width: 400, height: 600 });
    expect(sent.meta.orientation).toBeUndefined();
  });

  it('resizes large photos to fit OPENROUTER_IMAGE_MAX_EDGE, even when small in bytes', async () => {
    const large = await photo(4000, 3000).png().toBuffer();
    expect(large.length).toBeLessThan(1_500_000);

    const sent = await sentImage({ bytes: large, mimeType: 'image/png' });

    expect(sent.meta).toMatchObject({
      format: 'jpeg',
      width: 1600,
      height: 1200,
    });
  });

  it('never enlarges small photos', async () => {
    const sent = await sentImage({
      bytes: await photo(400, 320).webp().toBuffer(),
      mimeType: 'image/webp',
    });

    expect(sent.meta).toMatchObject({
      format: 'jpeg',
      width: 400,
      height: 320,
    });
  });

  it('flattens transparency onto white and sends JPEG', async () => {
    const transparent = await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    const sent = await sentImage({ bytes: transparent, mimeType: 'image/png' });

    expect(sent.meta).toMatchObject({
      format: 'jpeg',
      channels: 3,
      hasAlpha: false,
    });
    const { data } = await sharp(sent.bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);
  });

  it('shrinks until the image fits OPENROUTER_IMAGE_MAX_BYTES', async () => {
    const noise = await sharp(
      Buffer.from(
        Array.from({ length: 1200 * 900 * 3 }, (_, i) => (i * 7919) % 251),
      ),
      { raw: { width: 1200, height: 900, channels: 3 } },
    )
      .png()
      .toBuffer();

    const sent = await sentImage(
      { bytes: noise, mimeType: 'image/png' },
      { OPENROUTER_IMAGE_MAX_BYTES: '120000' },
    );

    expect(sent.bytes.length).toBeLessThanOrEqual(120_000);
  });

  it.each([
    [
      'a corrupted object',
      Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.alloc(64, 7),
      ]),
      'AI_IMAGE_INVALID',
    ],
    [
      'a provider error page',
      Buffer.from('<html><body>storage error</body></html>'),
      'AI_IMAGE_INVALID',
    ],
  ])(
    'rejects %s without contacting OpenRouter and without retrying',
    async (_label, bytes, code) => {
      const fetchSpy = jest.spyOn(global, 'fetch');

      const error = await provider()
        .generateStructured(request({ bytes, mimeType: 'image/jpeg' }))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AiProviderError);
      expect(error).toMatchObject({ code, retryable: false });
      expect((error as Error).message).toBe(
        'The photo could not be processed. Please upload it again.',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('fails without retrying when the image cannot be made small enough', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const error = await provider({ OPENROUTER_IMAGE_MAX_BYTES: '300' })
      .generateStructured(
        request({
          bytes: await photo(800, 600).jpeg().toBuffer(),
          mimeType: 'image/jpeg',
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'AI_IMAGE_TOO_LARGE',
      retryable: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('embeds only image bytes: no URL of any kind reaches OpenRouter for the image', async () => {
    const sent = await sentImage({
      bytes: await photo(500, 500).jpeg().toBuffer(),
      mimeType: 'image/jpeg',
    });

    const content = (
      JSON.parse(sent.body) as {
        messages: Array<{ content: unknown }>;
      }
    ).messages[1].content as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    const imagePart = content.find((part) => part.type === 'image_url');
    expect(
      imagePart?.image_url?.url.startsWith('data:image/jpeg;base64,'),
    ).toBe(true);
    expect(sent.body).not.toMatch(
      /https?:\/\/[^"]*(storage|supabase|amazonaws|s3)/i,
    );
  });
});
