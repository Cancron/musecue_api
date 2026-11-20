-- Optional SMS sign-in verification for users with authenticator-app MFA.
--
-- - "MfaSmsPhone": the user's phone numbers for SMS codes (encrypted with
--   MFA_ENCRYPTION_KEY; only the last two digits in clear). At most one
--   ACTIVE (verified) and one PENDING (being verified) number per user.
-- - "MfaSmsCode": SMS codes (HMAC only; 5 minutes; single use), for an MFA
--   sign-in challenge (LOGIN) or a number being verified.
-- - "authSecurity"."mfaSmsSentAt" / "mfaSmsAttemptsAt": SMS deliveries (at
--   most 3) and submitted SMS codes (at most 5) of the last 15 minutes.
-- - Step-up actions MFA_SMS_PHONE (add or replace a number) and
--   MFA_SMS_PHONE_REMOVE; security events of SMS.
--
-- Additive only: nobody has SMS verification until they add a number.

-- CreateEnum
CREATE TYPE "MfaSmsPhoneStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "MfaSmsCodePurpose" AS ENUM ('LOGIN', 'PHONE_VERIFICATION');

-- AlterEnum
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_SMS_PHONE_VERIFICATION_STARTED';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_SMS_ENABLED';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_SMS_PHONE_REPLACED';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_SMS_DISABLED';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_SMS_CODE_SENT';

-- AlterEnum
ALTER TYPE "StepUpAction" ADD VALUE 'MFA_SMS_PHONE';
ALTER TYPE "StepUpAction" ADD VALUE 'MFA_SMS_PHONE_REMOVE';

-- AlterTable
ALTER TABLE "authSecurity" ADD COLUMN     "mfaSmsAttemptsAt" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[],
ADD COLUMN     "mfaSmsSentAt" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[];

-- CreateTable
CREATE TABLE "MfaSmsPhone" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "status" "MfaSmsPhoneStatus" NOT NULL,
    "phoneNumber" TEXT,
    "phoneHint" VARCHAR(2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" VARCHAR(32),

    CONSTRAINT "MfaSmsPhone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaSmsCode" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "phoneId" TEXT NOT NULL,
    "purpose" "MfaSmsCodePurpose" NOT NULL,
    "loginChallengeId" TEXT,
    "codeHash" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),

    CONSTRAINT "MfaSmsCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MfaSmsPhone_authId_status_idx" ON "MfaSmsPhone"("authId", "status");

-- CreateIndex
CREATE INDEX "MfaSmsCode_authId_createdAt_idx" ON "MfaSmsCode"("authId", "createdAt");

-- CreateIndex
CREATE INDEX "MfaSmsCode_phoneId_idx" ON "MfaSmsCode"("phoneId");

-- CreateIndex
CREATE INDEX "MfaSmsCode_loginChallengeId_idx" ON "MfaSmsCode"("loginChallengeId");

-- CreateIndex
CREATE INDEX "MfaSmsCode_expiresAt_idx" ON "MfaSmsCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "MfaSmsPhone" ADD CONSTRAINT "MfaSmsPhone_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_phoneId_fkey" FOREIGN KEY ("phoneId") REFERENCES "MfaSmsPhone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_loginChallengeId_fkey" FOREIGN KEY ("loginChallengeId") REFERENCES "MfaLoginChallenge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Database rules (not modelled by Prisma):
-- the SMS delivery and attempt histories are short lists;
ALTER TABLE "authSecurity" ADD CONSTRAINT "authSecurity_mfaSmsSentAt_check"
    CHECK ("mfaSmsSentAt" IS NOT NULL AND cardinality("mfaSmsSentAt") <= 3);
ALTER TABLE "authSecurity" ADD CONSTRAINT "authSecurity_mfaSmsAttemptsAt_check"
    CHECK ("mfaSmsAttemptsAt" IS NOT NULL AND cardinality("mfaSmsAttemptsAt") <= 5);

-- a number is pending, active (verified) or revoked (its number erased);
ALTER TABLE "MfaSmsPhone" ADD CONSTRAINT "MfaSmsPhone_state_check"
    CHECK (
      "phoneHint" ~ '^[0-9]{2}$'
      AND (
        ("status" = 'PENDING' AND "phoneNumber" IS NOT NULL AND "verifiedAt" IS NULL AND "revokedAt" IS NULL)
        OR ("status" = 'ACTIVE' AND "phoneNumber" IS NOT NULL AND "verifiedAt" IS NOT NULL AND "revokedAt" IS NULL)
        OR ("status" = 'REVOKED' AND "phoneNumber" IS NULL AND "revokedAt" IS NOT NULL AND "revokedReason" IS NOT NULL)
      )
    );
-- one active and one pending number per user at most;
CREATE UNIQUE INDEX "MfaSmsPhone_one_active_key" ON "MfaSmsPhone"("authId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "MfaSmsPhone_one_pending_key" ON "MfaSmsPhone"("authId") WHERE "status" = 'PENDING';

-- only an HMAC is ever stored, never a plaintext code; a code lives at most
-- five minutes; a verification code never belongs to a sign-in challenge.
ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_codeHash_check"
    CHECK ("codeHash" ~ '^smsh1\.[0-9a-f]{16}\.[0-9a-f]{64}$');
ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_expiry_check"
    CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '5 minutes');
ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_purpose_check"
    CHECK ("purpose" = 'LOGIN' OR "loginChallengeId" IS NULL);

-- An SMS code is issued unused, for a sign-in challenge when it is a LOGIN
-- code, and keeps its owner, number, purpose, hash and lifetime for good.
-- It is used or invalidated at most once: once "consumedAt" or
-- "invalidatedAt" is set, neither can change again, so no code path can make
-- a code usable again. (Its sign-in challenge may be deleted: the reference
-- then becomes NULL and the code unusable.)
CREATE FUNCTION "MfaSmsCode_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."consumedAt" IS NOT NULL OR NEW."invalidatedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'MfaSmsCode must be issued unused'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."purpose" = 'LOGIN' AND NEW."loginChallengeId" IS NULL THEN
      RAISE EXCEPTION 'A LOGIN MfaSmsCode needs its sign-in challenge'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."phoneId" IS DISTINCT FROM OLD."phoneId"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."codeHash" IS DISTINCT FROM OLD."codeHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR (NEW."loginChallengeId" IS DISTINCT FROM OLD."loginChallengeId"
        AND NEW."loginChallengeId" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'MfaSmsCode owner, number, purpose, hash and lifetime cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."consumedAt" IS NOT NULL OR OLD."invalidatedAt" IS NOT NULL)
    AND (NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt"
      OR NEW."invalidatedAt" IS DISTINCT FROM OLD."invalidatedAt")
  THEN
    RAISE EXCEPTION 'A used or invalidated MfaSmsCode cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MfaSmsCode_protect"
  BEFORE INSERT OR UPDATE ON "MfaSmsCode"
  FOR EACH ROW EXECUTE FUNCTION "MfaSmsCode_protect"();
