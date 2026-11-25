-- Optional TOTP multi-factor authentication: enrollment state and the
-- confirmed, encrypted authenticator secret.

-- AlterTable
ALTER TABLE "authSecurity" ADD COLUMN     "mfaEnabledAt" TIMESTAMP(3),
ADD COLUMN     "mfaLastUsedStep" INTEGER;

-- Authenticator secrets are only ever stored encrypted
-- (v1.<iv>.<auth tag>.<ciphertext>, base64url), and MFA can only be enabled
-- together with a secret and a method. No earlier code wrote these columns;
-- this migration fails (and changes nothing) if a row was edited by hand to
-- hold a plaintext secret or MFA enabled without a secret.
ALTER TABLE "authSecurity" ADD CONSTRAINT "authSecurity_mfaSecret_encrypted_check"
  CHECK ("mfaSecret" IS NULL OR "mfaSecret" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
ALTER TABLE "authSecurity" ADD CONSTRAINT "authSecurity_mfaEnabled_requires_secret_check"
  CHECK (NOT "mfaEnabled" OR ("mfaSecret" IS NOT NULL AND "mfaMethod" IS NOT NULL));
ALTER TABLE "authSecurity" ADD CONSTRAINT "authSecurity_mfaLastUsedStep_check"
  CHECK ("mfaLastUsedStep" IS NULL OR "mfaLastUsedStep" >= 0);

-- CreateTable
CREATE TABLE "MfaEnrollment" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "secret" TEXT,
    "expiresAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "failureWindowStartedAt" TIMESTAMP(3),
    "blockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MfaEnrollment_pkey" PRIMARY KEY ("id"),
    -- A pending secret always has an expiry, and only an encrypted one is stored.
    CONSTRAINT "MfaEnrollment_pending_check"
      CHECK (("secret" IS NULL) = ("expiresAt" IS NULL)),
    CONSTRAINT "MfaEnrollment_secret_encrypted_check"
      CHECK ("secret" IS NULL OR "secret" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
    CONSTRAINT "MfaEnrollment_failedAttempts_check" CHECK ("failedAttempts" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaEnrollment_authId_key" ON "MfaEnrollment"("authId");

-- CreateIndex
CREATE INDEX "MfaEnrollment_expiresAt_idx" ON "MfaEnrollment"("expiresAt");

-- AddForeignKey
ALTER TABLE "MfaEnrollment" ADD CONSTRAINT "MfaEnrollment_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
