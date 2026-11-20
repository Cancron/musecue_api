-- Step-up authentication for sensitive actions.
--
-- - "RefreshSession"."familyId": the stable ID of a sign-in session (kept by
--   every refresh-token rotation); access tokens carry it as `sid`.
-- - "StepUpApproval": a ten-minute approval of one sensitive action for one
--   user and one sign-in session (SHA-256 of the approval token only).
--
-- Existing sessions get the ID of the first session of their rotation chain,
-- so a session that is still in use keeps one ID. Access tokens issued before
-- this migration have no `sid`: they keep working, but cannot approve
-- sensitive actions until the app refreshes them (or the user signs in).

-- CreateEnum
CREATE TYPE "StepUpAction" AS ENUM ('MFA_ENROLLMENT', 'MFA_RECOVERY_CODES', 'SUBSCRIPTION_CANCEL', 'DATA_EXPORT', 'DATA_EXPORT_DOWNLOAD', 'ACCOUNT_DELETION');

-- CreateEnum
CREATE TYPE "StepUpMethod" AS ENUM ('TOTP', 'RECOVERY_CODE', 'PASSWORD', 'GOOGLE');

-- AlterTable (backfilled before it becomes required)
ALTER TABLE "RefreshSession" ADD COLUMN     "familyId" TEXT;

WITH RECURSIVE "chain" ("id", "root") AS (
    SELECT "id", "id" FROM "RefreshSession" WHERE "rotatedFromId" IS NULL
  UNION ALL
    SELECT s."id", c."root"
    FROM "RefreshSession" s JOIN "chain" c ON s."rotatedFromId" = c."id"
)
UPDATE "RefreshSession" r SET "familyId" = c."root"
FROM "chain" c WHERE r."id" = c."id";
UPDATE "RefreshSession" SET "familyId" = "id" WHERE "familyId" IS NULL;

ALTER TABLE "RefreshSession" ALTER COLUMN "familyId" SET NOT NULL;

-- CreateTable
CREATE TABLE "StepUpApproval" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "sessionId" VARCHAR(64) NOT NULL,
    "action" "StepUpAction" NOT NULL,
    "method" "StepUpMethod" NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StepUpApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StepUpApproval_tokenHash_key" ON "StepUpApproval"("tokenHash");

-- CreateIndex
CREATE INDEX "StepUpApproval_authId_sessionId_action_idx" ON "StepUpApproval"("authId", "sessionId", "action");

-- CreateIndex
CREATE INDEX "StepUpApproval_expiresAt_idx" ON "StepUpApproval"("expiresAt");

-- CreateIndex
CREATE INDEX "RefreshSession_familyId_idx" ON "RefreshSession"("familyId");

-- AddForeignKey
ALTER TABLE "StepUpApproval" ADD CONSTRAINT "StepUpApproval_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Database rules (not modelled by Prisma): approval tokens are stored only
-- as SHA-256 digests, and an approval lasts at most ten minutes.
ALTER TABLE "StepUpApproval" ADD CONSTRAINT "StepUpApproval_tokenHash_check"
    CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "StepUpApproval" ADD CONSTRAINT "StepUpApproval_expiry_check"
    CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes');
