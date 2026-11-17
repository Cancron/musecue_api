import type { DataExportErrorCode } from '@prisma/client';
import { PRIVACY_EXPORT_QUEUE } from '../infrastructure/jobs/job-queues';

/** Queue that builds personal-data export archives. */
export { PRIVACY_EXPORT_QUEUE };
export const PRIVACY_EXPORT_JOB = 'BUILD_ARCHIVE';

/** A completed archive is retained for 24 hours, then expires. */
export const PRIVACY_EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Bumped whenever the archive layout or a document shape changes. */
export const PRIVACY_EXPORT_FORMAT_VERSION = 1;

export const PRIVACY_EXPORT_MAX_ATTEMPTS = 3;

/**
 * Signed download links live at most 15 minutes (and never beyond the
 * archive's own expiry). PRIVACY_EXPORT_DOWNLOAD_TTL_SECONDS may shorten this
 * but cannot raise it.
 */
export const PRIVACY_EXPORT_DOWNLOAD_MAX_TTL_SECONDS = 15 * 60;
export const PRIVACY_EXPORT_DOWNLOAD_MIN_TTL_SECONDS = 60;
export const PRIVACY_EXPORT_LIST_LIMIT = 20;

/**
 * Why an export failed, with the message shown to the user. Internal causes
 * (paths, SQL, provider errors) are never exposed.
 */
export const PRIVACY_EXPORT_FAILURES = {
  GENERATION_FAILED:
    'The export could not be generated. Please request a new export.',
  STORAGE_FULL:
    'The export could not be generated because storage is temporarily full. Please request a new export later.',
  ACCOUNT_UNAVAILABLE:
    'The export could not be generated because the account is no longer available.',
  INTERRUPTED: 'The export was interrupted. Please request a new export.',
  QUEUE_UNAVAILABLE:
    'The export could not be queued. Please request a new export.',
} as const satisfies Record<DataExportErrorCode, string>;

/** `Idempotency-Key` header format accepted by POST /v1/privacy/exports. */
export const PRIVACY_EXPORT_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9_.:-]{1,128}$/;
