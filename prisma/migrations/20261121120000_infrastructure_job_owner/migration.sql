-- Background jobs of the PostgreSQL queue driver (REDIS_ENABLED=false) belong
-- to the account they were created for. Deleting (erasing) an account deletes
-- its jobs, so no email is sent to an erased account afterwards and no job
-- payload of it is kept for diagnosis. Jobs without an owner keep a NULL.

-- AlterTable
ALTER TABLE "InfrastructureJob" ADD COLUMN "authId" TEXT;

-- CreateIndex
CREATE INDEX "InfrastructureJob_authId_idx" ON "InfrastructureJob"("authId");

-- Jobs already queued are owned by the account named in their (encrypted)
-- payload, which SQL cannot read; they keep running without an owner. They
-- are short-lived (completed jobs are removed after an hour).

-- AddForeignKey
ALTER TABLE "InfrastructureJob" ADD CONSTRAINT "InfrastructureJob_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
