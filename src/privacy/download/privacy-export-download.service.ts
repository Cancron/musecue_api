import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DataExport } from '@prisma/client';
import AppError from '../../common/errors/app.error';
import { PrismaService } from '../../common/services/prisma.service';
import {
  type OpenedArchive,
  PrivacyExportStorageService,
} from '../../storage/privacy-export-storage.service';
import {
  PRIVACY_EXPORT_DOWNLOAD_MAX_TTL_SECONDS,
  PRIVACY_EXPORT_DOWNLOAD_MIN_TTL_SECONDS,
} from '../privacy-export.constants';
import {
  DownloadSigningUnavailableError,
  PrivacyExportLinkSigner,
} from './privacy-export-link.signer';

/** A temporary link to download one completed export. */
export interface DownloadLinkView {
  /** Relative to the API base URL; send it with the owner's bearer token. */
  url: string;
  method: 'GET';
  /** The link stops working at this time (at most 15 minutes after issue). */
  expiresAt: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export interface ArchiveDownload {
  archive: OpenedArchive;
  fileName: string;
  sha256: string;
}

type DownloadableExport = DataExport & {
  storageKey: string;
  sha256: string;
  sizeBytes: bigint;
  completedAt: Date;
  expiresAt: Date;
};

const INVALID_LINK = 'This download link is invalid';

/**
 * Issues and redeems signed download links for completed personal-data
 * exports. Links are bound to the export, its owner, the archive's checksum
 * and an expiry of at most 15 minutes. Redeeming a link also requires the
 * owner's access token: the signature is verified against the caller's user
 * ID, so a link is useless to anyone else even when it leaks.
 */
@Injectable()
export class PrivacyExportDownloadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signer: PrivacyExportLinkSigner,
    private readonly storage: PrivacyExportStorageService,
    private readonly config: ConfigService,
  ) {}

  async createLink(
    authId: string,
    exportId: string,
    now: Date = new Date(),
  ): Promise<DownloadLinkView> {
    const record = await this.prisma.dataExport.findFirst({
      where: { id: exportId, authId },
    });
    if (!record) throw AppError.notFound('Data export not found');
    const downloadable = this.assertDownloadable(record, now);

    const nowSeconds = Math.floor(now.getTime() / 1000);
    const expires = Math.min(
      nowSeconds + this.ttlSeconds(),
      // Never outlive the archive itself.
      Math.floor(downloadable.expiresAt.getTime() / 1000),
    );
    if (expires <= nowSeconds) throw AppError.gone('The export has expired');

    const signature = this.sign({
      exportId,
      authId,
      archiveSha256: downloadable.sha256,
      expires,
    });
    const query = new URLSearchParams({ expires: String(expires), signature });
    return {
      url: `/v1/privacy/exports/${exportId}/archive?${query.toString()}`,
      method: 'GET',
      expiresAt: new Date(expires * 1000).toISOString(),
      fileName: this.fileName(downloadable),
      sizeBytes: Number(downloadable.sizeBytes),
      sha256: downloadable.sha256,
    };
  }

  async openDownload(
    authId: string,
    exportId: string,
    expires: number,
    signature: string,
    now: Date = new Date(),
  ): Promise<ArchiveDownload> {
    // Only the caller's own export is considered: another user's export ID
    // is indistinguishable from a forged link.
    const record = await this.prisma.dataExport.findFirst({
      where: { id: exportId, authId },
    });
    if (
      !record?.sha256 ||
      !this.verify(
        { exportId, authId, archiveSha256: record.sha256, expires },
        signature,
      )
    ) {
      throw AppError.forbidden(INVALID_LINK);
    }

    const nowMs = now.getTime();
    if (expires * 1000 <= nowMs) {
      throw AppError.gone('This download link has expired');
    }
    // Defense in depth: no link is honored for longer than the maximum,
    // whatever was signed.
    if (
      expires * 1000 - nowMs >
      PRIVACY_EXPORT_DOWNLOAD_MAX_TTL_SECONDS * 1000
    ) {
      throw AppError.forbidden(INVALID_LINK);
    }

    const downloadable = this.assertDownloadable(record, now);
    const archive = await this.storage.openArchive(downloadable.storageKey);
    if (!archive) {
      throw AppError.gone('The export archive is no longer available');
    }
    if (BigInt(archive.sizeBytes) !== downloadable.sizeBytes) {
      archive.stream.destroy();
      throw AppError.gone('The export archive is no longer available');
    }
    return {
      archive,
      fileName: this.fileName(downloadable),
      sha256: downloadable.sha256,
    };
  }

  /** Pending, failed and expired exports cannot be downloaded. */
  private assertDownloadable(
    record: DataExport,
    now: Date,
  ): DownloadableExport {
    if (record.status === 'QUEUED' || record.status === 'PROCESSING') {
      throw AppError.conflict('The export is not ready yet');
    }
    if (record.status === 'FAILED') {
      throw AppError.conflict('The export failed and cannot be downloaded');
    }
    if (
      record.status !== 'COMPLETED' ||
      !record.storageKey ||
      !record.sha256 ||
      record.sizeBytes === null ||
      !record.completedAt ||
      !record.expiresAt ||
      record.expiresAt.getTime() <= now.getTime()
    ) {
      throw AppError.gone('The export has expired');
    }
    return record as DownloadableExport;
  }

  private ttlSeconds(): number {
    const configured = Number(
      this.config.get<string>('PRIVACY_EXPORT_DOWNLOAD_TTL_SECONDS'),
    );
    if (!Number.isInteger(configured)) {
      return PRIVACY_EXPORT_DOWNLOAD_MAX_TTL_SECONDS;
    }
    return Math.min(
      PRIVACY_EXPORT_DOWNLOAD_MAX_TTL_SECONDS,
      Math.max(PRIVACY_EXPORT_DOWNLOAD_MIN_TTL_SECONDS, configured),
    );
  }

  private fileName(record: DownloadableExport): string {
    return `musecue-data-export-${record.completedAt.toISOString().slice(0, 10)}.zip`;
  }

  private sign(claims: Parameters<PrivacyExportLinkSigner['sign']>[0]) {
    try {
      return this.signer.sign(claims);
    } catch (error) {
      if (error instanceof DownloadSigningUnavailableError) {
        throw AppError.serviceUnavailable(
          'Downloads are temporarily unavailable',
        );
      }
      throw error;
    }
  }

  private verify(
    claims: Parameters<PrivacyExportLinkSigner['verify']>[0],
    signature: string,
  ): boolean {
    try {
      return this.signer.verify(claims, signature);
    } catch (error) {
      if (error instanceof DownloadSigningUnavailableError) {
        throw AppError.serviceUnavailable(
          'Downloads are temporarily unavailable',
        );
      }
      throw error;
    }
  }
}
