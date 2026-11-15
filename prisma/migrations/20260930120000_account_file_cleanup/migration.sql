-- Per-file cleanup of a deleted account's private storage, before its data is
-- erased: the account stays closed (PENDING_DELETION) and is not considered
-- deleted until every private file has been handled.

-- AlterEnum (not used elsewhere in this migration)
ALTER TYPE "AccountDeletionFileKind" ADD VALUE 'EXPORT_FILE';

-- CreateEnum
CREATE TYPE "AccountDeletionFileOutcome" AS ENUM ('DELETED', 'ALREADY_MISSING', 'RETAINED_SHARED', 'RETAINED_NOT_OWNED');

-- AccountDeletionFile: "resolved" (deleted, already missing, or kept because
-- another user shares the file) replaces "deleted".
ALTER TABLE "AccountDeletionFile" RENAME COLUMN "deletedAt" TO "resolvedAt";
ALTER INDEX "AccountDeletionFile_requestId_deletedAt_idx" RENAME TO "AccountDeletionFile_requestId_resolvedAt_idx";
ALTER TABLE "AccountDeletionFile" ADD COLUMN     "outcome" "AccountDeletionFileOutcome",
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" VARCHAR(500);
UPDATE "AccountDeletionFile" SET "outcome" = 'DELETED' WHERE "resolvedAt" IS NOT NULL;
ALTER TABLE "AccountDeletionFile"
  ADD CONSTRAINT "AccountDeletionFile_outcome_when_resolved" CHECK (
    ("resolvedAt" IS NULL) = ("outcome" IS NULL)
  ),
  ADD CONSTRAINT "AccountDeletionFile_attempts_non_negative" CHECK ("attempts" >= 0);

-- AccountDeletionRequest: references are recorded first, files are removed
-- next, and only then is the account's data erased.
ALTER TABLE "AccountDeletionRequest" ADD COLUMN     "referencesRecordedAt" TIMESTAMP(3);

ALTER TABLE "AccountDeletionRequest"
  -- Replaced: files are now removed before the data, not after.
  DROP CONSTRAINT "AccountDeletionRequest_files_after_data",
  -- Files are only finished after their references were recorded (requests
  -- started before this migration recorded them with the data erasure).
  ADD CONSTRAINT "AccountDeletionRequest_files_after_references" CHECK (
    "filesDeletedAt" IS NULL
    OR "referencesRecordedAt" IS NOT NULL
    OR "dataErasedAt" IS NOT NULL
  ),
  -- The account is only erased (deleted) once its files are gone. Requests
  -- started before this migration (no referencesRecordedAt) erased the data
  -- first and finish their files afterwards.
  ADD CONSTRAINT "AccountDeletionRequest_data_after_files" CHECK (
    "dataErasedAt" IS NULL
    OR "filesDeletedAt" IS NOT NULL
    OR "referencesRecordedAt" IS NULL
  );
