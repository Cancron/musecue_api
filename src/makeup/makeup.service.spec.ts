import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import { PrivateImageStorageService } from '../storage/private-image-storage.service';
import { MakeupQueueService } from './queues/makeup.queue';
import { ImageValidationService } from './services/image-validation.service';
import { MakeupService } from './makeup.service';

describe('MakeupService history media and deletion', () => {
  const prisma = mockDeep<PrismaService>();
  const queue = mock<MakeupQueueService>();
  const imageValidation = mock<ImageValidationService>();
  const imageStorage = mock<PrivateImageStorageService>();
  const service = new MakeupService(
    prisma,
    queue,
    imageValidation,
    imageStorage,
  );

  beforeEach(() => jest.clearAllMocks());

  it('returns private image bytes only after the ownership query succeeds', async () => {
    const bytes = Buffer.from('private-image');
    prisma.imageAsset.findFirst.mockResolvedValue({
      storageKey: 'owner/session/image.jpg',
      mimeType: 'image/jpeg',
      source: 'PRIVATE_UPLOAD',
    } as never);
    imageStorage.read.mockResolvedValue(bytes);

    await expect(
      service.getImageContent('owner-id', 'image-id'),
    ).resolves.toEqual({
      mimeType: 'image/jpeg',
      bytes,
    });
    expect(prisma.imageAsset.findFirst.mock.calls[0]?.[0]).toEqual({
      where: { id: 'image-id', session: { authId: 'owner-id' } },
      select: { storageKey: true, mimeType: true, source: true },
    });
  });

  it('does not read storage when the image is not owned by the user', async () => {
    prisma.imageAsset.findFirst.mockResolvedValue(null);

    await expect(
      service.getImageContent('other-user', 'image-id'),
    ).rejects.toThrow('Image not found');
    expect(imageStorage.read.mock.calls).toHaveLength(0);
  });

  it('deletes a completed aggregate and its private files', async () => {
    prisma.makeupSession.findFirst.mockResolvedValue({
      id: 'session-id',
      status: 'COMPLETED',
      images: [{ storageKey: 'owner/session/image.jpg' }],
    } as never);
    prisma.makeupSession.deleteMany.mockResolvedValue({ count: 1 });
    imageStorage.delete.mockResolvedValue();

    await expect(
      service.deleteSession('owner-id', 'session-id'),
    ).resolves.toEqual({
      id: 'session-id',
    });
    expect(imageStorage.delete.mock.calls[0]?.[0]).toBe(
      'owner/session/image.jpg',
    );
  });

  it('refuses to delete an active workflow from history', async () => {
    prisma.makeupSession.findFirst.mockResolvedValue({
      id: 'session-id',
      status: 'IN_PROGRESS',
      images: [],
    } as never);

    await expect(
      service.deleteSession('owner-id', 'session-id'),
    ).rejects.toThrow('Only completed sessions can be deleted from history');
    expect(prisma.makeupSession.deleteMany.mock.calls).toHaveLength(0);
  });

  it('promotes the final step check photo to the completion photo', async () => {
    prisma.guideStep.findFirst.mockResolvedValue({
      id: 'final-step',
      guideId: 'guide-id',
      position: 2,
      status: 'CURRENT',
      guide: {
        sessionId: 'session-id',
        startedAt: new Date(),
        steps: [{ id: 'final-step', position: 2 }],
      },
    } as never);
    prisma.stepAttempt.findFirst.mockResolvedValue({
      imageId: 'final-image',
    } as never);
    prisma.makeupSession.findFirst.mockResolvedValue({
      id: 'session-id',
      status: 'COMPLETED',
    } as never);
    prisma.$transaction.mockImplementation(async (callback) =>
      (callback as (client: PrismaService) => Promise<unknown>)(prisma),
    );

    await service.completeStep('owner-id', 'final-step', {});

    expect(prisma.imageAsset.updateMany.mock.calls[0]?.[0]).toEqual({
      where: { id: 'final-image', sessionId: 'session-id' },
      data: { purpose: 'COMPLETION' },
    });
  });
});
