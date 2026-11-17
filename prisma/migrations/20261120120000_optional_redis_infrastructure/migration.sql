-- Optional Redis: authentication security state moves to PostgreSQL (in both
-- infrastructure modes), and the PostgreSQL queue and rate-limit drivers used
-- when REDIS_ENABLED=false get their tables.
--
-- Deploying this migration signs every user out: all token versions are
-- incremented, and refresh sessions, email verification codes, account
-- deletion codes and OAuth states that were kept in Redis are no longer read.
-- Users sign in again and request new codes.

-- CreateEnum
CREATE TYPE "RefreshSessionRevocation" AS ENUM ('ROTATED', 'LOGOUT', 'LOGOUT_ALL', 'DEVICE_LIMIT', 'REUSE_DETECTED', 'ACCOUNT_INACTIVE', 'SECURITY_EVENT');

-- CreateEnum
CREATE TYPE "AuthChallengePurpose" AS ENUM ('EMAIL_VERIFICATION', 'ACCOUNT_DELETION');

-- CreateEnum
CREATE TYPE "InfrastructureJobStatus" AS ENUM ('WAITING', 'ACTIVE', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "AiRun" ADD COLUMN "jobInput" JSONB;

-- CreateTable
CREATE TABLE "RefreshSession" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "tokenId" VARCHAR(128) NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "device" TEXT,
    "rotatedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" "RefreshSessionRevocation",

    CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthChallenge" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "purpose" "AuthChallengePurpose" NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "stateHash" CHAR(64) NOT NULL,
    "payload" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InfrastructureJob" (
    "id" TEXT NOT NULL,
    "queue" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "jobKey" VARCHAR(255),
    "payload" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "InfrastructureJobStatus" NOT NULL DEFAULT 'WAITING',
    "attemptsMade" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "backoffType" VARCHAR(16),
    "backoffDelayMs" INTEGER NOT NULL DEFAULT 0,
    "backoffJitter" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "removeOnComplete" BOOLEAN NOT NULL DEFAULT false,
    "removeOnFail" BOOLEAN NOT NULL DEFAULT false,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" VARCHAR(64),
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastError" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InfrastructureJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "keyHash" CHAR(64) NOT NULL,
    "hits" INTEGER NOT NULL,
    "windowExpiresAt" TIMESTAMP(3) NOT NULL,
    "blockExpiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("keyHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefreshSession_tokenId_key" ON "RefreshSession"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshSession_rotatedFromId_key" ON "RefreshSession"("rotatedFromId");

-- CreateIndex
CREATE INDEX "RefreshSession_authId_revokedAt_expiresAt_idx" ON "RefreshSession"("authId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "RefreshSession_expiresAt_idx" ON "RefreshSession"("expiresAt");

-- CreateIndex
CREATE INDEX "AuthChallenge_expiresAt_idx" ON "AuthChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthChallenge_authId_purpose_key" ON "AuthChallenge"("authId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_stateHash_key" ON "OAuthState"("stateHash");

-- CreateIndex
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- CreateIndex
CREATE INDEX "InfrastructureJob_queue_status_priority_availableAt_idx" ON "InfrastructureJob"("queue", "status", "priority", "availableAt");

-- CreateIndex
CREATE INDEX "InfrastructureJob_status_leaseExpiresAt_idx" ON "InfrastructureJob"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "InfrastructureJob_status_finishedAt_idx" ON "InfrastructureJob"("status", "finishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InfrastructureJob_queue_jobKey_key" ON "InfrastructureJob"("queue", "jobKey");

-- CreateIndex
CREATE INDEX "RateLimitBucket_windowExpiresAt_idx" ON "RateLimitBucket"("windowExpiresAt");

-- AddForeignKey
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_rotatedFromId_fkey" FOREIGN KEY ("rotatedFromId") REFERENCES "RefreshSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthChallenge" ADD CONSTRAINT "AuthChallenge_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------------------
-- Rules not expressible in the Prisma schema.
-- ------------------------------------------------------------------------

ALTER TABLE "RefreshSession"
  ADD CONSTRAINT "RefreshSession_revocation_reason" CHECK (
    ("revokedAt" IS NULL) = ("revokedReason" IS NULL)
  ),
  ADD CONSTRAINT "RefreshSession_expiry_after_creation" CHECK ("expiresAt" > "createdAt");

ALTER TABLE "AuthChallenge"
  ADD CONSTRAINT "AuthChallenge_attempts_range" CHECK (
    "maxAttempts" >= 1 AND "attempts" >= 0 AND "attempts" <= "maxAttempts"
  );

ALTER TABLE "InfrastructureJob"
  ADD CONSTRAINT "InfrastructureJob_attempts_range" CHECK (
    "maxAttempts" >= 1 AND "attemptsMade" >= 0
  ),
  ADD CONSTRAINT "InfrastructureJob_backoff" CHECK (
    "backoffDelayMs" >= 0 AND "backoffJitter" >= 0 AND "backoffJitter" <= 1
  ),
  -- Only a leased (ACTIVE) job has a lease; only an unfinished job a payload
  -- is needed for (a completed job's payload is cleared).
  ADD CONSTRAINT "InfrastructureJob_lease" CHECK (
    ("status" = 'ACTIVE') = ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "InfrastructureJob_pending_has_payload" CHECK (
    "status" NOT IN ('WAITING', 'ACTIVE') OR "payload" IS NOT NULL
  );

ALTER TABLE "RateLimitBucket"
  ADD CONSTRAINT "RateLimitBucket_hits_positive" CHECK ("hits" >= 1);

-- The operation input of an AI run is written once, when the run is created.
CREATE FUNCTION "AiRun_protect_job_input"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."jobInput" IS DISTINCT FROM OLD."jobInput" THEN
    RAISE EXCEPTION 'AiRun.jobInput is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiRun_protect_job_input"
  BEFORE UPDATE OF "jobInput" ON "AiRun"
  FOR EACH ROW EXECUTE FUNCTION "AiRun_protect_job_input"();

-- Sign every user out: access tokens carry the previous token version, and
-- refresh sessions stored in Redis are not migrated.
UPDATE "authUser" SET "tokenVersion" = "tokenVersion" + 1;
