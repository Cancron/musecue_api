import type { DataExportStatus } from '@prisma/client';

/** The status of a personal-data export as returned by the API. */
export interface DataExportView {
  id: string;
  /** `EXPIRED` is derived from `expiresAt` at read time. */
  status: DataExportStatus;
  /** 0-100. */
  progress: number;
  requestedAt: string;
  startedAt: string | null;
  /** When processing finished (successfully or not). */
  completedAt: string | null;
  /** When a completed archive stops being available. */
  expiresAt: string | null;
  sizeBytes: number | null;
  /** SHA-256 of the ZIP archive, for integrity checks after download. */
  sha256: string | null;
  photoCount: number | null;
  missingPhotoCount: number | null;
  error: string | null;
}

export interface PrivacyExportJob {
  exportId: string;
  authId: string;
}

/** Reports archive progress (0-100); rejects when the attempt was superseded. */
export type PrivacyExportProgress = (progress: number) => Promise<void>;

export interface PrivacyExportArchiveResult {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  photoCount: number;
  missingPhotoCount: number;
}
