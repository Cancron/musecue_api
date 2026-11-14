import type { DataExportErrorCode } from '@prisma/client';

/** BullMQ queue that builds personal-data export archives. */
export const PRIVACY_EXPORT_QUEUE = 'privacy-export';
export const PRIVACY_EXPORT_JOB = 'BUILD_ARCHIVE';

/** A completed archive is retained for 24 hours, then expires. */
export const PRIVACY_EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Bumped whenever the archive layout or a document shape changes. */
export const PRIVACY_EXPORT_FORMAT_VERSION = 1;

export const PRIVACY_EXPORT_MAX_ATTEMPTS = 3;
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
