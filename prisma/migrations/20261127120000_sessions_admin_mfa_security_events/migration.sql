-- Active-session management, the administrator MFA policy and the security
-- activity history.
--
-- - "RefreshSessionRevocation": USER_REVOKED (ended from the session list)
--   and MFA_ENABLED (ended because MFA was enabled in another session).
-- - "RefreshSession"."mfaVerifiedAt" / "mfaVerifiedWith": when and how the
--   sign-in session last proved MFA (administrators need a recent proof).
-- - "SecurityEvent": the security activity history of each account.
--
-- Additive: existing sessions have no MFA proof (administrators verify MFA
-- once in their session), and the history starts empty.

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('MFA_ENROLLMENT_STARTED', 'MFA_ENABLED', 'MFA_DISABLED', 'MFA_AUTHENTICATOR_REPLACEMENT_STARTED', 'MFA_AUTHENTICATOR_REPLACED', 'MFA_RECOVERY_CODES_REGENERATED', 'MFA_RECOVERY_CODE_USED', 'MFA_VERIFICATION_FAILED', 'MFA_VERIFICATION_BLOCKED', 'TRUSTED_DEVICE_ADDED', 'TRUSTED_DEVICE_REVOKED', 'SESSION_REVOKED');

-- AlterEnum


ALTER TYPE "RefreshSessionRevocation" ADD VALUE 'USER_REVOKED';
ALTER TYPE "RefreshSessionRevocation" ADD VALUE 'MFA_ENABLED';

-- AlterTable
ALTER TABLE "RefreshSession" ADD COLUMN     "mfaVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "mfaVerifiedWith" VARCHAR(32);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "type" "SecurityEventType" NOT NULL,
    "sessionId" VARCHAR(64),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityEvent_authId_createdAt_id_idx" ON "SecurityEvent"("authId", "createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Database rules (not modelled by Prisma): a session's MFA proof is an
-- authenticator or a recovery code, and always has its time. No other method
-- (for example SMS) can ever be recorded as an MFA proof.
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_mfaVerified_check"
    CHECK (
      ("mfaVerifiedAt" IS NULL AND "mfaVerifiedWith" IS NULL)
      OR ("mfaVerifiedAt" IS NOT NULL AND "mfaVerifiedWith" IN ('totp', 'recovery_code'))
    );
