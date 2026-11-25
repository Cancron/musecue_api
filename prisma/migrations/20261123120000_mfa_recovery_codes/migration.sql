-- MFA recovery codes and the failed-verification counter.

-- AlterTable
ALTER TABLE "authSecurity" ADD COLUMN     "mfaBlockedUntil" TIMESTAMP(3),
ADD COLUMN     "mfaFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfaFailureWindowStartedAt" TIMESTAMP(3);

ALTER TABLE "authSecurity" ADD CONSTRAINT "authSecurity_mfaFailedAttempts_check"
  CHECK ("mfaFailedAttempts" >= 0);

-- CreateTable
CREATE TABLE "MfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),

    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id"),
    -- Only a keyed hash (lowercase hex) is ever stored, never a code.
    CONSTRAINT "MfaRecoveryCode_codeHash_check" CHECK ("codeHash" ~ '^[0-9a-f]{64}$')
);

-- CreateIndex
CREATE INDEX "MfaRecoveryCode_authId_invalidatedAt_usedAt_idx" ON "MfaRecoveryCode"("authId", "invalidatedAt", "usedAt");

-- CreateIndex
CREATE INDEX "MfaRecoveryCode_invalidatedAt_idx" ON "MfaRecoveryCode"("invalidatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MfaRecoveryCode_authId_codeHash_key" ON "MfaRecoveryCode"("authId", "codeHash");

-- AddForeignKey
ALTER TABLE "MfaRecoveryCode" ADD CONSTRAINT "MfaRecoveryCode_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A recovery code's use and invalidation are permanent: once set, usedAt and
-- invalidatedAt never change (a used or replaced code can never work again),
-- and a code's identity (owner, set, hash) never changes. Rows can still be
-- deleted (account erasure, removal of long-replaced codes). Prisma does not
-- model triggers; it is kept in migrations only.
CREATE FUNCTION "MfaRecoveryCode_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."batchId" IS DISTINCT FROM OLD."batchId"
    OR NEW."codeHash" IS DISTINCT FROM OLD."codeHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'MfaRecoveryCode identity cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt" THEN
    RAISE EXCEPTION 'A used MFA recovery code cannot be restored'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."invalidatedAt" IS NOT NULL
    AND NEW."invalidatedAt" IS DISTINCT FROM OLD."invalidatedAt" THEN
    RAISE EXCEPTION 'An invalidated MFA recovery code cannot be restored'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MfaRecoveryCode_protect"
  BEFORE UPDATE ON "MfaRecoveryCode"
  FOR EACH ROW EXECUTE FUNCTION "MfaRecoveryCode_protect"();
