import { Inject, Injectable } from '@nestjs/common';
import type { DataExport } from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import { PrivacyExportStorageService } from '../storage/privacy-export-storage.service';
import type { DataExportView } from './interfaces/privacy-export.interface';
import {
  PRIVACY_EXPORT_LIST_LIMIT,
  PRIVACY_EXPORT_QUEUE_FAILURE_MESSAGE,
} from './privacy-export.constants';
import { failExport } from './queues/privacy-export-lifecycle';
import { PrivacyExportQueueService } from './queues/privacy-export.queue';

/**
 * Personal-data export requests and status. Every read and write is scoped to
 * the authenticated owner's ID; an export of another user is indistinguishable
 * from one that does not exist.
 */
@Injectable()
export class PrivacyExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PrivacyExportQueueService,
    private readonly storage: PrivacyExportStorageService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /**
   * Queues a new export, or returns the export that already answers this
   * request: the one created with the same idempotency key, or the owner's
   * export that is still waiting or running (one at a time per user).
   */
  async requestExport(
    authId: string,
    idempotencyKey?: string,
  ): Promise<DataExportView> {
    const existing = await this.findReusable(authId, idempotencyKey);
    if (existing) return this.toView(existing);

    let created: DataExport;
    try {
      created = await this.prisma.dataExport.create({
        data: {
          authId,
          idempotencyKey: idempotencyKey ?? `auto:${randomUUID()}`,
        },
      });
    } catch (error) {
      // A concurrent request won the unique key or the one-active-export rule.
      if (this.isUniqueConstraintError(error)) {
        const winner = await this.findReusable(authId, idempotencyKey);
        if (winner) return this.toView(winner);
      }
      throw error;
    }

    try {
      await this.queue.enqueue({ exportId: created.id, authId });
    } catch (error) {
      await failExport(
        this.prisma,
        this.storage,
        created.id,
        PRIVACY_EXPORT_QUEUE_FAILURE_MESSAGE,
      );
      this.logger.error('Personal data export could not be queued', {
        context: 'PrivacyExportService',
        exportId: created.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw AppError.serviceUnavailable(
        'Data export is temporarily unavailable. Please try again later.',
      );
    }
    return this.toView(created);
  }

  async getExport(
    authId: string,
    exportId: string,
    now: Date = new Date(),
  ): Promise<DataExportView> {
    const record = await this.prisma.dataExport.findFirst({
      where: { id: exportId, authId },
    });
    if (!record) throw AppError.notFound('Data export not found');
    return this.toView(record, now);
  }

  async listExports(
    authId: string,
    now: Date = new Date(),
  ): Promise<DataExportView[]> {
    const records = await this.prisma.dataExport.findMany({
      where: { authId },
      orderBy: { createdAt: 'desc' },
      take: PRIVACY_EXPORT_LIST_LIMIT,
    });
    return records.map((record) => this.toView(record, now));
  }

  private async findReusable(
    authId: string,
    idempotencyKey?: string,
  ): Promise<DataExport | null> {
    if (idempotencyKey) {
      const byKey = await this.prisma.dataExport.findUnique({
        where: { authId_idempotencyKey: { authId, idempotencyKey } },
      });
      if (byKey) return byKey;
    }
    return this.prisma.dataExport.findFirst({
      where: { authId, status: { in: ['QUEUED', 'PROCESSING'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The public shape. Storage keys and idempotency keys are never returned. */
  private toView(record: DataExport, now: Date = new Date()): DataExportView {
    const expired =
      record.status === 'EXPIRED' ||
      (record.status === 'COMPLETED' &&
        record.expiresAt !== null &&
        record.expiresAt.getTime() <= now.getTime());
    const iso = (date: Date | null) => date?.toISOString() ?? null;
    return {
      id: record.id,
      status: expired ? 'EXPIRED' : record.status,
      progress: record.progress,
      requestedAt: record.createdAt.toISOString(),
      startedAt: iso(record.startedAt),
      completedAt: iso(record.completedAt),
      expiresAt: iso(record.expiresAt),
      sizeBytes: record.sizeBytes === null ? null : Number(record.sizeBytes),
      sha256: expired ? null : record.sha256,
      photoCount: record.photoCount,
      missingPhotoCount: record.missingPhotoCount,
      error: record.error,
    };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}
