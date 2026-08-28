import { Readable } from 'node:stream';
import sharp from 'sharp';
import { ImageValidationService } from './image-validation.service';

function uploadedFile(buffer: Buffer): Express.Multer.File {
  return {
    fieldname: 'image',
    originalname: 'face.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    size: buffer.length,
    stream: Readable.from(buffer),
    destination: '',
    filename: '',
    path: '',
    buffer,
  };
}

describe('ImageValidationService', () => {
  const service = new ImageValidationService();

  it('derives trusted metadata from a readable image', async () => {
    const buffer = await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: { r: 218, g: 174, b: 168 },
      },
    })
      .jpeg()
      .toBuffer();

    await expect(service.validate(uploadedFile(buffer))).resolves.toEqual({
      mimeType: 'image/jpeg',
      width: 640,
      height: 480,
      sizeBytes: buffer.length,
    });
  });

  it('rejects non-image bytes even when the client claims JPEG', async () => {
    const file = uploadedFile(Buffer.from('not-an-image'));

    await expect(service.validate(file)).rejects.toThrow(
      'The uploaded file is not a readable image',
    );
  });

  it('rejects images below the minimum resolution', async () => {
    const buffer = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 218, g: 174, b: 168 },
      },
    })
      .png()
      .toBuffer();

    await expect(service.validate(uploadedFile(buffer))).rejects.toThrow(
      'The image must be at least 320 by 320 pixels',
    );
  });
});
