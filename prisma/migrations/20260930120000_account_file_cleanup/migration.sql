-- Private file cleanup of deleted accounts: files are deleted BEFORE the
-- account is hard-deleted, every file reference records its outcome, and
-- references stay until they are resolved so failures are retried.

-- AlterEnum (not used elsewhere in this migration)
ALTER TYPE "AccountDeletionFileKind" ADD VALUE 'EXPORT_ARCHIVE';

-- CreateEnum
CREATE TYPE "AccountDeletionFileStatus" AS ENUM ('PENDING', 'DELETED', 'MISSING', 'RETAINED');

-- AlterTable: per-file outcome, attempts and errors
ALTER TABLE "AccountDeletionFile" RENAME COLUMN "deletedAt" TO "resolvedAt";
ALTER TABLE "AccountDeletionFile" ADD COLUMN     "status" "AccountDeletionFileStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" VARCHAR(200),
ADD COLUMN     "note" VARCHAR(200);
UPDATE "AccountDeletionFile" SET "status" = 'DELETED' WHERE "resolvedAt" IS NOT NULL;

-- DropIndex / CreateIndex
DROP INDEX "AccountDeletionFile_requestId_deletedAt_idx";
CREATE INDEX "AccountDeletionFile_requestId_status_idx" ON "AccountDeletionFile"("requestId", "status");

ALTER TABLE "AccountDeletionFile"
  ADD CONSTRAINT "AccountDeletionFile_resolution_consistent" CHECK (
    ("status" = 'PENDING') = ("resolvedAt" IS NULL)
  ),
  ADD CONSTRAINT "AccountDeletionFile_attempts_non_negative" CHECK ("attempts" >= 0);

-- AlterTable: the files are recorded first, as their own step
ALTER TABLE "AccountDeletionRequest" ADD COLUMN     "filesRecordedAt" TIMESTAMP(3);
-- Requests processed with the earlier order recorded their files together
-- with the data.
UPDATE "AccountDeletionRequest"
SET "filesRecordedAt" = COALESCE("dataErasedAt", "filesDeletedAt")
WHERE "dataErasedAt" IS NOT NULL OR "filesDeletedAt" IS NOT NULL;

-- The earlier rule (files only after the data) encoded the opposite order.
ALTER TABLE "AccountDeletionRequest"
  DROP CONSTRAINT "AccountDeletionRequest_files_after_data",
  -- Files are only considered deleted once they were recorded.
  ADD CONSTRAINT "AccountDeletionRequest_files_deleted_after_recorded" CHECK (
    "filesDeletedAt" IS NULL OR "filesRecordedAt" IS NOT NULL
  );
