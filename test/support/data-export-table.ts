import type { DataExport, DataExportStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/common/services/prisma.service';
import type { DeepMockProxy } from 'jest-mock-extended';

const ACTIVE: DataExportStatus[] = ['QUEUED', 'PROCESSING'];

type Where = Record<string, unknown>;
type Data = Record<string, unknown>;

/**
 * In-memory DataExport table for unit tests. It applies the same rules as the
 * migrations: unique (authId, idempotencyKey), one QUEUED/PROCESSING export
 * per user (violations throw Prisma's P2002), and the FAILED-state checks.
 */
export class DataExportTable {
  rows: DataExport[] = [];

  private uniqueViolation(): Error {
    return Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
  }

  private equal(value: unknown, expected: unknown): boolean {
    if (expected instanceof Date) {
      return value instanceof Date && value.getTime() === expected.getTime();
    }
    return value === expected;
  }

  /** Supports the operators the export code uses: lt, lte, gt. */
  private compare(value: unknown, operators: Record<string, unknown>): boolean {
    const key = (item: unknown) =>
      item instanceof Date ? item.getTime() : (item as string | number);
    return Object.entries(operators).every(([operator, operand]) => {
      if (value === null || value === undefined) return false;
      const left = key(value);
      const right = key(operand);
      if (operator === 'lt') return left < right;
      if (operator === 'lte') return left <= right;
      if (operator === 'gt') return left > right;
      throw new Error(`Unsupported operator "${operator}" in fixture`);
    });
  }

  private matches(row: DataExport, where: Where = {}): boolean {
    return Object.entries(where).every(([field, expected]) => {
      const value = row[field as keyof DataExport];
      if (
        expected !== null &&
        typeof expected === 'object' &&
        !(expected instanceof Date) &&
        'in' in expected
      ) {
        return (expected.in as unknown[]).includes(value);
      }
      if (
        expected !== null &&
        typeof expected === 'object' &&
        !(expected instanceof Date)
      ) {
        return this.compare(value, expected as Record<string, unknown>);
      }
      return this.equal(value, expected);
    });
  }

  private checkRow(row: DataExport): void {
    if (
      row.status === 'FAILED' &&
      (!row.error || !row.errorCode || !row.completedAt || row.storageKey)
    ) {
      throw new Error('DataExport_failed_has_reason violated');
    }
    if (row.errorCode && row.status !== 'FAILED') {
      throw new Error('DataExport_error_code_only_when_failed violated');
    }
    if (
      row.status === 'EXPIRED' &&
      (!row.storageKey || !row.sha256 || !row.completedAt || !row.expiresAt)
    ) {
      throw new Error('DataExport_expired_keeps_archive_reference violated');
    }
    if (row.filesDeletedAt && !['FAILED', 'EXPIRED'].includes(row.status)) {
      throw new Error('DataExport_files_deleted_only_when_terminal violated');
    }
    const active = this.rows.filter(
      (other) => other.authId === row.authId && ACTIVE.includes(other.status),
    );
    if (active.length > 1) throw this.uniqueViolation();
  }

  private apply(row: DataExport, data: Data): void {
    for (const [field, value] of Object.entries(data)) {
      const current = row[field as keyof DataExport];
      (row as Record<string, unknown>)[field] =
        value !== null &&
        typeof value === 'object' &&
        'increment' in value &&
        typeof current === 'number'
          ? current + (value.increment as number)
          : value;
    }
    row.updatedAt = new Date();
  }

  findUnique = ({ where }: { where: Where }) => {
    const compound = where.authId_idempotencyKey as
      | { authId: string; idempotencyKey: string }
      | undefined;
    return Promise.resolve(
      this.rows.find((row) =>
        compound
          ? row.authId === compound.authId &&
            row.idempotencyKey === compound.idempotencyKey
          : row.id === where.id,
      ) ?? null,
    );
  };

  findFirst = ({ where }: { where: Where }) =>
    Promise.resolve(
      [...this.rows].reverse().find((row) => this.matches(row, where)) ?? null,
    );

  findMany = ({
    where,
    take,
    orderBy,
  }: {
    where: Where;
    take?: number;
    orderBy?: Record<string, 'asc' | 'desc'>;
  }) => {
    const found = this.rows.filter((row) => this.matches(row, where));
    const [field, direction] = Object.entries(orderBy ?? {})[0] ?? [];
    const ordered =
      field === 'id'
        ? [...found].sort((a, b) =>
            direction === 'desc'
              ? b.id.localeCompare(a.id)
              : a.id.localeCompare(b.id),
          )
        : direction === 'desc'
          ? [...found].reverse()
          : found;
    return Promise.resolve(ordered.slice(0, take));
  };

  create = async ({
    data,
  }: {
    data: { authId: string; idempotencyKey: string };
  }) => {
    // Yield like a real database round trip so concurrent requests interleave.
    await new Promise((resolve) => setImmediate(resolve));
    if (
      this.rows.some(
        (row) =>
          row.authId === data.authId &&
          (row.idempotencyKey === data.idempotencyKey ||
            ACTIVE.includes(row.status)),
      )
    ) {
      throw this.uniqueViolation();
    }
    const now = new Date(Date.now() + this.rows.length);
    const row: DataExport = {
      id: randomUUID(),
      authId: data.authId,
      status: 'QUEUED',
      progress: 0,
      idempotencyKey: data.idempotencyKey,
      attempts: 0,
      storageKey: null,
      sizeBytes: null,
      sha256: null,
      photoCount: null,
      missingPhotoCount: null,
      error: null,
      errorCode: null,
      startedAt: null,
      completedAt: null,
      expiresAt: null,
      filesDeletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return row;
  };

  updateMany = ({ where, data }: { where: Where; data: Data }) => {
    const targets = this.rows.filter((row) => this.matches(row, where));
    for (const row of targets) {
      const before = { ...row };
      this.apply(row, data);
      try {
        this.checkRow(row);
      } catch (error) {
        Object.assign(row, before);
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return Promise.resolve({ count: targets.length });
  };

  get(id: string): DataExport {
    const row = this.rows.find((item) => item.id === id);
    if (!row) throw new Error(`No export ${id}`);
    return row;
  }

  /** Routes the Prisma mock's dataExport delegate to this table. */
  attach(prisma: DeepMockProxy<PrismaService>): this {
    prisma.dataExport.findUnique.mockImplementation(this.findUnique as never);
    prisma.dataExport.findFirst.mockImplementation(this.findFirst as never);
    prisma.dataExport.findMany.mockImplementation(this.findMany as never);
    prisma.dataExport.create.mockImplementation(this.create as never);
    prisma.dataExport.updateMany.mockImplementation(this.updateMany as never);
    return this;
  }
}
