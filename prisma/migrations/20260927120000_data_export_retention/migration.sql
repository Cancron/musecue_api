-- Retention of personal data export archives.
--
-- A COMPLETED export becomes EXPIRED when its archive passes expiresAt
-- (completion + 24 hours); the retention sweep then deletes its files and
-- records filesDeletedAt. The row keeps storageKey throughout, so a cleanup
-- that did not happen (or failed) can always be retried from the database.

-- Only a published archive can expire, and it never loses its reference.
ALTER TABLE "DataExport"
  ADD CONSTRAINT "DataExport_expired_keeps_archive_reference" CHECK (
    "status" <> 'EXPIRED' OR (
      "storageKey" IS NOT NULL
      AND "sha256" IS NOT NULL
      AND "completedAt" IS NOT NULL
      AND "expiresAt" IS NOT NULL
    )
  ),
  -- Files are only ever recorded as deleted for finished (terminal) exports.
  ADD CONSTRAINT "DataExport_files_deleted_only_when_terminal" CHECK (
    "filesDeletedAt" IS NULL OR "status" IN ('FAILED', 'EXPIRED')
  );
