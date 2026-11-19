-- Optional MFA with an authenticator app (TOTP): enrollment state and replay
-- protection.
--
-- - "MfaEnrollment" holds one user's enrollment in progress (the pending TOTP
--   secret, encrypted, valid for 10 minutes) and the incorrect confirmation
--   codes of the last 15 minutes that can temporarily block enrollment.
-- - "authSecurity"."mfaLastUsedStep" records the TOTP time step of the last
--   accepted code, so an accepted code is never accepted again.
--
-- Additive only: existing users keep "mfaEnabled" = false and nothing else
-- changes. Applies to fresh and populated databases.

-- AlterTable
ALTER TABLE "authSecurity" ADD COLUMN     "mfaLastUsedStep" INTEGER;

-- CreateTable
CREATE TABLE "MfaEnrollment" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "secret" TEXT,
    "expiresAt" TIMESTAMP(3),
    "failedAttemptsAt" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[],
    "blockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MfaEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaEnrollment_authId_key" ON "MfaEnrollment"("authId");

-- CreateIndex
CREATE INDEX "MfaEnrollment_expiresAt_idx" ON "MfaEnrollment"("expiresAt");

-- AddForeignKey
ALTER TABLE "MfaEnrollment" ADD CONSTRAINT "MfaEnrollment_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Database rules (not modelled by Prisma):
-- a pending secret always has its expiry, and never the other way round;
ALTER TABLE "MfaEnrollment" ADD CONSTRAINT "MfaEnrollment_pending_secret_expiry_check"
    CHECK (("secret" IS NULL) = ("expiresAt" IS NULL));
-- the failure history is a list of at most five incorrect codes.
ALTER TABLE "MfaEnrollment" ADD CONSTRAINT "MfaEnrollment_failed_attempts_check"
    CHECK ("failedAttemptsAt" IS NOT NULL AND cardinality("failedAttemptsAt") <= 5);
