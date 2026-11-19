-- MFA recovery codes and MFA verification lockout.
--
-- - "MfaRecoveryCode": the single-use recovery codes of a user with MFA
--   enabled. Only an HMAC-SHA-256 of each code is stored (keyed with a
--   server secret and bound to the user); "usedAt" records its consumption.
-- - "authSecurity"."mfaFailedAttemptsAt" / "mfaBlockedUntil": incorrect MFA
--   verification codes of the last 15 minutes and the resulting block.
--
-- Additive only. Users who enabled MFA before this migration have no recovery
-- codes until they generate them (POST /auth/mfa/recovery-codes).

-- AlterTable
ALTER TABLE "authSecurity" ADD COLUMN     "mfaBlockedUntil" TIMESTAMP(3),
ADD COLUMN     "mfaFailedAttemptsAt" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[];

-- CreateTable
CREATE TABLE "MfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaRecoveryCode_codeHash_key" ON "MfaRecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "MfaRecoveryCode_authId_usedAt_idx" ON "MfaRecoveryCode"("authId", "usedAt");

-- AddForeignKey
ALTER TABLE "MfaRecoveryCode" ADD CONSTRAINT "MfaRecoveryCode_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Database rules (not modelled by Prisma):
-- only a hex digest can ever be stored, never a plaintext code;
ALTER TABLE "MfaRecoveryCode" ADD CONSTRAINT "MfaRecoveryCode_codeHash_check"
    CHECK ("codeHash" ~ '^[0-9a-f]{64}$');
-- the verification failure history is a list of at most five entries.
ALTER TABLE "authSecurity" ADD CONSTRAINT "authSecurity_mfaFailedAttemptsAt_check"
    CHECK ("mfaFailedAttemptsAt" IS NOT NULL AND cardinality("mfaFailedAttemptsAt") <= 5);

-- A recovery code is issued unused, belongs to one user for good, and is
-- consumed at most once: "usedAt" can only change from NULL to a time, so no
-- code path can make a used code usable again. Codes may be deleted
-- (regeneration, account erasure).
CREATE FUNCTION "MfaRecoveryCode_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."usedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'MfaRecoveryCode must be issued unused'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."codeHash" IS DISTINCT FROM OLD."codeHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'MfaRecoveryCode owner, hash and creation time cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt" THEN
    RAISE EXCEPTION 'A used MfaRecoveryCode cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MfaRecoveryCode_protect"
  BEFORE INSERT OR UPDATE ON "MfaRecoveryCode"
  FOR EACH ROW EXECUTE FUNCTION "MfaRecoveryCode_protect"();
