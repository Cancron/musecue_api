-- Coordination between export workers and account erasure: a worker holds a
-- renewable lease on the export it is building, so erasure can wait until no
-- worker of the account can still write to storage.

-- AlterTable
ALTER TABLE "DataExport" ADD COLUMN     "workerLeaseUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "DataExport_authId_workerLeaseUntil_idx" ON "DataExport"("authId", "workerLeaseUntil");
