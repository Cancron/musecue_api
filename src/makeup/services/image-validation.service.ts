import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import AppError from '../../common/errors/app.error';

const MAX_IMAGE_BYTES = 10_000_000;
const MIN_IMAGE_DIMENSION = 320;
const MAX_IMAGE_DIMENSION = 8192;
const MIME_BY_FORMAT = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

export interface ValidatedImage {
  mimeType: (typeof MIME_BY_FORMAT)[keyof typeof MIME_BY_FORMAT];
  width: number;
  height: number;
  sizeBytes: number;
}

@Injectable()
export class ImageValidationService {
  async validate(file: Express.Multer.File): Promise<ValidatedImage> {
    if (!file.buffer.length)
      throw AppError.badRequest('An image file is required');
    if (file.size > MAX_IMAGE_BYTES) {
      throw AppError.badRequest('The image must be 10 MB or smaller');
    }

    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(file.buffer, {
        failOn: 'error',
        limitInputPixels: MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION,
      }).metadata();
    } catch {
      throw AppError.badRequest('The uploaded file is not a readable image');
    }

    const mimeType = metadata.format
      ? MIME_BY_FORMAT[metadata.format as keyof typeof MIME_BY_FORMAT]
      : undefined;
    if (!mimeType) {
      throw AppError.badRequest(
        'Only JPEG, PNG, and WebP images are supported',
      );
    }

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION) {
      throw AppError.badRequest('The image must be at least 320 by 320 pixels');
    }
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      throw AppError.badRequest(
        'The image dimensions cannot exceed 8192 pixels',
      );
    }

    return { mimeType, width, height, sizeBytes: file.size };
  }
}
