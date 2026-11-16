-- AlterEnum
-- (Not used elsewhere in this migration, so it is safe inside its transaction.)
ALTER TYPE "userStatus" ADD VALUE 'PENDING_DELETION';

-- CreateEnum
CREATE TYPE "AccountDeletionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AccountDeletionVerification" AS ENUM ('PASSWORD', 'EMAIL_CODE');

-- CreateTable
CREATE TABLE "AccountDeletionRequest" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "status" "AccountDeletionStatus" NOT NULL DEFAULT 'PENDING',
    "verificationMethod" "AccountDeletionVerification" NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountBlockedAt" TIMESTAMP(3) NOT NULL,
    "sessionsRevokedAt" TIMESTAMP(3),
    "processingStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(500),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountDeletionRequest_authId_idx" ON "AccountDeletionRequest"("authId");

-- CreateIndex
CREATE INDEX "AccountDeletionRequest_status_sessionsRevokedAt_idx" ON "AccountDeletionRequest"("status", "sessionsRevokedAt");

-- Rules not expressible in the Prisma schema.
-- The request deliberately has no foreign key to "authUser": it must outlive
-- the account it deletes.

-- One open (not yet completed) deletion request per account, so repeated or
-- concurrent requests can never start a second deletion.
CREATE UNIQUE INDEX "AccountDeletionRequest_one_open_per_account"
  ON "AccountDeletionRequest"("authId")
  WHERE "status" <> 'COMPLETED';

ALTER TABLE "AccountDeletionRequest"
  ADD CONSTRAINT "AccountDeletionRequest_attempts_non_negative" CHECK ("attempts" >= 0),
  -- The account is blocked no earlier than the request was made.
  ADD CONSTRAINT "AccountDeletionRequest_blocked_after_request" CHECK (
    "accountBlockedAt" >= "requestedAt"
  ),
  -- Completion is recorded exactly for completed requests, which must have
  -- revoked every session first.
  ADD CONSTRAINT "AccountDeletionRequest_completion_consistent" CHECK (
    ("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)
    AND ("status" <> 'COMPLETED' OR "sessionsRevokedAt" IS NOT NULL)
  );
