-- CreateEnum
CREATE TYPE "DataExportErrorCode" AS ENUM ('GENERATION_FAILED', 'STORAGE_FULL', 'ACCOUNT_UNAVAILABLE', 'INTERRUPTED', 'QUEUE_UNAVAILABLE');

-- AlterTable
ALTER TABLE "DataExport" ADD COLUMN     "errorCode" "DataExportErrorCode",
ADD COLUMN     "filesDeletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "DataExport_status_filesDeletedAt_idx" ON "DataExport"("status", "filesDeletedAt");

-- Exports that failed before failure codes existed keep a reason; their files
-- are left for the cleanup sweep (filesDeletedAt stays NULL).
UPDATE "DataExport"
SET "errorCode" = 'GENERATION_FAILED',
    "error" = COALESCE("error", 'The export could not be generated. Please request a new export.'),
    "completedAt" = COALESCE("completedAt", "updatedAt")
WHERE "status" = 'FAILED';
UPDATE "DataExport" SET "storageKey" = NULL WHERE "status" = 'FAILED';

-- Consistency rules (not expressible in the Prisma schema).
ALTER TABLE "DataExport"
  -- A failed export always tells the user why, and when it stopped.
  ADD CONSTRAINT "DataExport_failed_has_reason" CHECK (
    "status" <> 'FAILED' OR (
      "error" IS NOT NULL AND "errorCode" IS NOT NULL AND "completedAt" IS NOT NULL
    )
  ),
  -- Only a failed export has a failure code.
  ADD CONSTRAINT "DataExport_error_code_only_when_failed" CHECK (
    "errorCode" IS NULL OR "status" = 'FAILED'
  ),
  -- A failed export never points at an archive.
  ADD CONSTRAINT "DataExport_failed_has_no_archive" CHECK (
    "status" <> 'FAILED' OR "storageKey" IS NULL
  );
