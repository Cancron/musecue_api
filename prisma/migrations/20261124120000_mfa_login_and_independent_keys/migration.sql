-- MFA at sign-in (challenges, trusted devices) and MFA credentials that no
-- longer depend on JWT_REFRESH_SECRET.
--
-- - "MfaLoginChallenge": the pending second step of a sign-in of a user with
--   MFA enabled (SHA-256 of an opaque token, five minutes, single use).
-- - "MfaTrustedDevice": devices trusted for 30 days after MFA (SHA-256 of the
--   device token), per user, revocable.
-- - "MfaRecoveryCode"."codeHash" becomes a salted scrypt hash (no key).
--
-- Existing data written by the previous MFA build:
-- - Recovery codes were keyed HMACs under a key derived from
--   JWT_REFRESH_SECRET. They cannot be converted (only the user knows the
--   codes) and the new scheme cannot verify them, so they are deleted here.
--   Affected users keep their authenticator app and create new codes with
--   POST /auth/mfa/recovery-codes; `npm run mfa:rekey` lists them.
-- - Pending enrollment secrets in the old format are cleared (enrollments
--   last ten minutes; the user starts again).
-- - Confirmed authenticator secrets in the old format ("v1.") stay until
--   `npm run mfa:rekey` re-encrypts them with MFA_ENCRYPTION_KEY; run it
--   right after this migration (see README, "MFA keys").

-- DropIndex
DROP INDEX "MfaRecoveryCode_codeHash_key";

-- Old recovery-code hashes: unverifiable without the JWT-derived key.
ALTER TABLE "MfaRecoveryCode" DROP CONSTRAINT "MfaRecoveryCode_codeHash_check";
DELETE FROM "MfaRecoveryCode" WHERE "codeHash" !~ '^scrypt\$';

-- AlterTable
ALTER TABLE "MfaRecoveryCode" ALTER COLUMN "codeHash" SET DATA TYPE TEXT;

-- Old pending enrollment secrets.
UPDATE "MfaEnrollment" SET "secret" = NULL, "expiresAt" = NULL
WHERE "secret" LIKE 'v1.%';


-- CreateTable
CREATE TABLE "MfaLoginChallenge" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "device" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaLoginChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaTrustedDevice" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "MfaTrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaLoginChallenge_tokenHash_key" ON "MfaLoginChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "MfaLoginChallenge_authId_idx" ON "MfaLoginChallenge"("authId");

-- CreateIndex
CREATE INDEX "MfaLoginChallenge_expiresAt_idx" ON "MfaLoginChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MfaTrustedDevice_tokenHash_key" ON "MfaTrustedDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "MfaTrustedDevice_authId_revokedAt_expiresAt_idx" ON "MfaTrustedDevice"("authId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "MfaTrustedDevice_expiresAt_idx" ON "MfaTrustedDevice"("expiresAt");

-- AddForeignKey
ALTER TABLE "MfaLoginChallenge" ADD CONSTRAINT "MfaLoginChallenge_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaTrustedDevice" ADD CONSTRAINT "MfaTrustedDevice_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Database rules (not modelled by Prisma):
-- recovery codes are stored only as scrypt hashes: scrypt$<log2 N>$<r>$<p>$<salt>$<hash>;
ALTER TABLE "MfaRecoveryCode" ADD CONSTRAINT "MfaRecoveryCode_codeHash_check"
    CHECK ("codeHash" ~ '^scrypt\$[0-9]{1,2}\$[0-9]{1,2}\$[0-9]\$[A-Za-z0-9_-]{22,}\$[A-Za-z0-9_-]{43}$');
-- challenge and device tokens are stored only as SHA-256 digests;
ALTER TABLE "MfaLoginChallenge" ADD CONSTRAINT "MfaLoginChallenge_tokenHash_check"
    CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "MfaLoginChallenge" ADD CONSTRAINT "MfaLoginChallenge_provider_check"
    CHECK ("provider" IN ('local', 'google'));
ALTER TABLE "MfaLoginChallenge" ADD CONSTRAINT "MfaLoginChallenge_expiry_check"
    CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '15 minutes');
ALTER TABLE "MfaTrustedDevice" ADD CONSTRAINT "MfaTrustedDevice_tokenHash_check"
    CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
-- a device is trusted for at most 30 days.
ALTER TABLE "MfaTrustedDevice" ADD CONSTRAINT "MfaTrustedDevice_expiry_check"
    CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '30 days');

-- A trusted device belongs to one user for good, its token and trust period
-- never change (trust cannot be extended), and a revocation is permanent.
CREATE FUNCTION "MfaTrustedDevice_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
  THEN
    RAISE EXCEPTION 'MfaTrustedDevice owner, token and trust period cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'A revoked MfaTrustedDevice cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MfaTrustedDevice_protect"
  BEFORE UPDATE ON "MfaTrustedDevice"
  FOR EACH ROW EXECUTE FUNCTION "MfaTrustedDevice_protect"();
