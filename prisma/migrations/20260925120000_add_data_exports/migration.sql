-- CreateEnum
CREATE TYPE "DataExportStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "DataExport" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "status" "DataExportStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "storageKey" VARCHAR(512),
    "sizeBytes" BIGINT,
    "sha256" CHAR(64),
    "photoCount" INTEGER,
    "missingPhotoCount" INTEGER,
    "error" VARCHAR(500),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DataExport_authId_idempotencyKey_key" ON "DataExport"("authId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "DataExport_authId_createdAt_idx" ON "DataExport"("authId", "createdAt");

-- CreateIndex
CREATE INDEX "DataExport_status_expiresAt_idx" ON "DataExport"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "DataExport" ADD CONSTRAINT "DataExport_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Consistency rules (not expressible in the Prisma schema).
ALTER TABLE "DataExport"
  ADD CONSTRAINT "DataExport_progress_range" CHECK ("progress" BETWEEN 0 AND 100),
  ADD CONSTRAINT "DataExport_attempts_non_negative" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "DataExport_size_non_negative" CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0),
  ADD CONSTRAINT "DataExport_photo_counts_non_negative" CHECK (
    ("photoCount" IS NULL OR "photoCount" >= 0)
    AND ("missingPhotoCount" IS NULL OR "missingPhotoCount" >= 0)
  ),
  -- A completed export always describes a stored archive and its retention window.
  ADD CONSTRAINT "DataExport_completed_has_archive" CHECK (
    "status" <> 'COMPLETED' OR (
      "storageKey" IS NOT NULL
      AND "sizeBytes" IS NOT NULL
      AND "sha256" IS NOT NULL
      AND "completedAt" IS NOT NULL
      AND "expiresAt" IS NOT NULL
      AND "progress" = 100
    )
  ),
  ADD CONSTRAINT "DataExport_expiry_after_completion" CHECK (
    "expiresAt" IS NULL OR ("completedAt" IS NOT NULL AND "expiresAt" > "completedAt")
  );

-- At most one export per user may be waiting or running. Concurrent requests
-- therefore converge on the same export instead of building duplicate archives.
CREATE UNIQUE INDEX "DataExport_one_active_per_user" ON "DataExport"("authId")
  WHERE "status" IN ('QUEUED', 'PROCESSING');
