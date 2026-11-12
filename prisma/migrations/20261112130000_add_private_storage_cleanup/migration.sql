-- Durable ledger of private storage objects that must be deleted (failed
-- uploads, replaced images/avatars, deleted sessions). Rows are removed only
-- after the provider confirms the deletion; exhausted rows stay as FAILED.

-- CreateEnum
CREATE TYPE "PrivateStorageCleanupReason" AS ENUM ('UPLOAD_PENDING', 'UPLOAD_ABANDONED', 'IMAGE_REPLACED', 'IMAGE_DISCARDED', 'SESSION_DELETED', 'AVATAR_REPLACED', 'AVATAR_REMOVED');

-- CreateEnum
CREATE TYPE "PrivateStorageCleanupStatus" AS ENUM ('PENDING', 'FAILED');

-- CreateTable
CREATE TABLE "PrivateStorageCleanup" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "storageKey" TEXT NOT NULL,
    "reason" "PrivateStorageCleanupReason" NOT NULL,
    "status" "PrivateStorageCleanupStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" VARCHAR(64),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivateStorageCleanup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrivateStorageCleanup_provider_storageKey_key" ON "PrivateStorageCleanup"("provider", "storageKey");

-- CreateIndex
CREATE INDEX "PrivateStorageCleanup_status_nextAttemptAt_idx" ON "PrivateStorageCleanup"("status", "nextAttemptAt");

-- CreateIndex: lets the cleaner verify an object is no longer referenced.
CREATE INDEX "ImageAsset_storageKey_idx" ON "ImageAsset"("storageKey");
