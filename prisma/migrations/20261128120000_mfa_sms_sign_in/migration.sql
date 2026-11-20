-- Optional SMS codes at sign-in for users with authenticator MFA.
--
-- - "MfaPhone": the verified phone number (encrypted; masked for display).
-- - "MfaSmsCode": SMS codes (HMAC only), for the MFA step of a sign-in or to
--   verify a new number; 5 minutes, single use.
-- - "authSecurity"."mfaSmsDeliveriesAt" / "mfaSmsAttemptsAt": the SMS
--   delivery (3) and verification (5) limits per 15 minutes.
-- - Step-up actions MFA_SMS_ENROLLMENT, MFA_SMS_REPLACE, MFA_SMS_DISABLE and
--   security events of SMS.
--
-- Additive: no user has a phone number yet.

-- CreateEnum
CREATE TYPE "MfaSmsCodePurpose" AS ENUM ('SIGN_IN', 'PHONE_ENROLLMENT', 'PHONE_REPLACEMENT');

-- AlterEnum
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_SMS_CODE_SENT';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_SMS_ENABLED';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_SMS_PHONE_REPLACED';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_SMS_DISABLED';

-- AlterEnum
ALTER TYPE "StepUpAction" ADD VALUE 'MFA_SMS_ENROLLMENT';
ALTER TYPE "StepUpAction" ADD VALUE 'MFA_SMS_REPLACE';
ALTER TYPE "StepUpAction" ADD VALUE 'MFA_SMS_DISABLE';

-- AlterTable
ALTER TABLE "authSecurity" ADD COLUMN     "mfaSmsAttemptsAt" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[],
ADD COLUMN     "mfaSmsDeliveriesAt" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[];

-- CreateTable
CREATE TABLE "MfaPhone" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "maskedNumber" VARCHAR(32) NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MfaPhone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaSmsCode" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "purpose" "MfaSmsCodePurpose" NOT NULL,
    "phoneId" TEXT,
    "challengeId" TEXT,
    "destination" TEXT,
    "maskedNumber" VARCHAR(32) NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),

    CONSTRAINT "MfaSmsCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaPhone_authId_key" ON "MfaPhone"("authId");

-- CreateIndex
CREATE INDEX "MfaSmsCode_authId_purpose_createdAt_idx" ON "MfaSmsCode"("authId", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "MfaSmsCode_challengeId_idx" ON "MfaSmsCode"("challengeId");

-- CreateIndex
CREATE INDEX "MfaSmsCode_phoneId_idx" ON "MfaSmsCode"("phoneId");

-- CreateIndex
CREATE INDEX "MfaSmsCode_expiresAt_idx" ON "MfaSmsCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "MfaPhone" ADD CONSTRAINT "MfaPhone_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_phoneId_fkey" FOREIGN KEY ("phoneId") REFERENCES "MfaPhone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "MfaLoginChallenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Database rules (not modelled by Prisma).

-- The limit windows are lists of at most 3 (deliveries) and 5 (checks).
ALTER TABLE "authSecurity" ADD CONSTRAINT "authSecurity_mfaSmsDeliveriesAt_check"
    CHECK ("mfaSmsDeliveriesAt" IS NOT NULL AND cardinality("mfaSmsDeliveriesAt") <= 3);
ALTER TABLE "authSecurity" ADD CONSTRAINT "authSecurity_mfaSmsAttemptsAt_check"
    CHECK ("mfaSmsAttemptsAt" IS NOT NULL AND cardinality("mfaSmsAttemptsAt") <= 5);

-- A code is an HMAC-SHA256 (never the code), lives at most 5 minutes, and is
-- either a sign-in code (bound to a challenge and the verified phone) or a
-- phone verification code (carrying the encrypted number being verified).
ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_codeHash_check"
    CHECK ("codeHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_lifetime_check"
    CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '5 minutes');
ALTER TABLE "MfaSmsCode" ADD CONSTRAINT "MfaSmsCode_purpose_check"
    CHECK (
      ("purpose" = 'SIGN_IN' AND "challengeId" IS NOT NULL AND "phoneId" IS NOT NULL AND "destination" IS NULL)
      OR ("purpose" <> 'SIGN_IN' AND "challengeId" IS NULL AND "phoneId" IS NULL AND "destination" IS NOT NULL)
    );

-- A code is issued open; once used or invalidated it stays so, and nothing
-- else about it can change. Codes may be deleted (cleanup, phone removal,
-- account erasure).
CREATE FUNCTION "MfaSmsCode_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."usedAt" IS NOT NULL OR NEW."invalidatedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'MfaSmsCode must be issued open'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."phoneId" IS DISTINCT FROM OLD."phoneId"
    OR NEW."challengeId" IS DISTINCT FROM OLD."challengeId"
    OR NEW."destination" IS DISTINCT FROM OLD."destination"
    OR NEW."codeHash" IS DISTINCT FROM OLD."codeHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
  THEN
    RAISE EXCEPTION 'MfaSmsCode cannot change except to end it'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt")
    OR (OLD."invalidatedAt" IS NOT NULL AND NEW."invalidatedAt" IS DISTINCT FROM OLD."invalidatedAt")
  THEN
    RAISE EXCEPTION 'An ended MfaSmsCode cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MfaSmsCode_protect"
  BEFORE INSERT OR UPDATE ON "MfaSmsCode"
  FOR EACH ROW EXECUTE FUNCTION "MfaSmsCode_protect"();
