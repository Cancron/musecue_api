-- Existing erasure references were local filesystem objects.
ALTER TABLE "AccountDeletionFile" ADD COLUMN "storageProvider" VARCHAR(32) NOT NULL DEFAULT 'local';
DROP INDEX "AccountDeletionFile_requestId_kind_storageKey_key";
CREATE UNIQUE INDEX "AccountDeletionFile_object_key" ON "AccountDeletionFile"("requestId", "kind", "storageProvider", "storageKey");
