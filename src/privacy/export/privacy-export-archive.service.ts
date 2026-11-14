import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrivateImageStorageService } from '../../storage/private-image-storage.service';
import { isMissingFileError } from '../../storage/private-storage-key';
import { PrivacyExportStorageService } from '../../storage/privacy-export-storage.service';
import type {
  PrivacyExportArchiveResult,
  PrivacyExportProgress,
} from '../interfaces/privacy-export.interface';
import {
  PrivacyExportCollectorService,
  type UnavailablePhoto,
} from './privacy-export-collector.service';
import {
  type ManifestEntry,
  renderExportDocuments,
  renderManifest,
  renderReadme,
} from './privacy-export-documents';
import { PrivacyZipWriter } from './privacy-zip-writer';

/** Progress checkpoints reported while an archive is built. */
export const ARCHIVE_PROGRESS = {
  COLLECTED: 15,
  PHOTOS_DONE: 90,
  DOCUMENTS_DONE: 95,
} as const;

/**
 * Builds one owner's personal-data ZIP archive in private export storage.
 * Photos are copied one at a time, so memory use is bounded by the largest
 * photo rather than by the size of the account.
 */
@Injectable()
export class PrivacyExportArchiveService {
  constructor(
    private readonly collector: PrivacyExportCollectorService,
    private readonly images: PrivateImageStorageService,
    private readonly exports: PrivacyExportStorageService,
  ) {}

  async build(
    authId: string,
    exportId: string,
    onProgress: PrivacyExportProgress,
  ): Promise<PrivacyExportArchiveResult> {
    const snapshot = await this.collector.collect(authId, exportId);
    await onProgress(ARCHIVE_PROGRESS.COLLECTED);

    const target = await this.exports.createArchive(authId, exportId);
    const zip = new PrivacyZipWriter(target.stream);
    const mtime = snapshot.generatedAt;
    const entries: ManifestEntry[] = [];
    const add = async (path: string, bytes: Buffer, compress: boolean) => {
      await zip.add(path, bytes, { compress, mtime });
      entries.push({
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    };

    try {
      const written = new Set<string>();
      const unavailable: UnavailablePhoto[] = [...snapshot.unavailablePhotos];
      const total = snapshot.photos.length;
      for (const [index, photo] of snapshot.photos.entries()) {
        let bytes: Buffer;
        try {
          bytes = await this.images.read(photo.storageKey);
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
          unavailable.push({
            kind: photo.kind,
            imageId: photo.imageId,
            sessionId: photo.sessionId,
            reason: 'FILE_MISSING',
          });
          continue;
        }
        await add(photo.archivePath, bytes, false);
        written.add(photo.archivePath);
        await onProgress(
          ARCHIVE_PROGRESS.COLLECTED +
            Math.floor(
              ((ARCHIVE_PROGRESS.PHOTOS_DONE - ARCHIVE_PROGRESS.COLLECTED) *
                (index + 1)) /
                total,
            ),
        );
      }

      await add('README.txt', Buffer.from(renderReadme(snapshot)), true);
      for (const document of renderExportDocuments(snapshot, written)) {
        await add(document.path, this.json(document.data), true);
      }
      await onProgress(ARCHIVE_PROGRESS.DOCUMENTS_DONE);

      await zip.add(
        'manifest.json',
        this.json(renderManifest(snapshot, entries, unavailable)),
        { compress: true, mtime },
      );
      const summary = await zip.finish();
      return {
        storageKey: target.storageKey,
        sizeBytes: summary.sizeBytes,
        sha256: summary.sha256,
        photoCount: written.size,
        // Mock captures never had a private file; only lost photos count.
        missingPhotoCount: unavailable.filter(
          (photo) => photo.reason !== 'NOT_STORED',
        ).length,
      };
    } catch (error) {
      await zip.abort();
      await this.exports.delete(target.storageKey).catch(() => undefined);
      throw error;
    }
  }

  private json(data: unknown): Buffer {
    return Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
  }
}
