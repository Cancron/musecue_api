import { mock } from 'jest-mock-extended';
import AppError from '../common/errors/app.error';
import { PrivateImageStorageService } from './private-image-storage.service';
import { PrivateStorageError } from './private-storage.error';
import {
  SIGNED_IMAGE_URL_TTL_SECONDS,
  issueSignedImageUrl,
} from './signed-image-url';

const REF = { provider: 'fake-s3', key: 'owner/profile/a.webp' };

describe('issueSignedImageUrl (private cloud storage)', () => {
  const storage = mock<PrivateImageStorageService>();

  beforeEach(() => jest.resetAllMocks());

  it('requests 60 s and reports the provider-issued window, not the requested one', async () => {
    storage.createSignedUrl.mockResolvedValue({
      url: 'https://fake-s3.example.test/b/owner/profile/a.webp?X-Amz-Expires=45',
      expiresAt: new Date('2026-11-12T12:00:45.000Z'),
      expiresInSeconds: 45,
    });

    await expect(
      issueSignedImageUrl(storage, REF, 'Avatar image is unavailable'),
    ).resolves.toEqual({
      url: 'https://fake-s3.example.test/b/owner/profile/a.webp?X-Amz-Expires=45',
      expiresAt: '2026-11-12T12:00:45.000Z',
      expiresInSeconds: 45,
    });
    expect(storage.createSignedUrl.mock.calls).toEqual([
      [REF, SIGNED_IMAGE_URL_TTL_SECONDS],
    ]);
    expect(SIGNED_IMAGE_URL_TTL_SECONDS).toBe(60);
  });

  it('maps storage failures to the caller-specific not-found message', async () => {
    storage.createSignedUrl.mockRejectedValue(
      new PrivateStorageError('OBJECT_NOT_FOUND'),
    );

    const error = (await issueSignedImageUrl(
      storage,
      REF,
      'Avatar image is unavailable',
    ).catch((caught: unknown) => caught)) as AppError;

    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toMatchObject({
      message: 'Avatar image is unavailable',
    });
  });
});
