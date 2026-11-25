-- Step-up authentication: session IDs, approvals and Google re-authentication.

-- CreateEnum
CREATE TYPE "StepUpAction" AS ENUM ('MFA_SETTINGS', 'MFA_RECOVERY_CODES', 'SUBSCRIPTION_CANCEL', 'PRIVACY_EXPORT', 'PRIVACY_EXPORT_DOWNLOAD', 'ACCOUNT_DELETION');

-- CreateEnum
CREATE TYPE "StepUpMethod" AS ENUM ('TOTP', 'RECOVERY_CODE', 'PASSWORD', 'GOOGLE');

-- AlterTable: every refresh session gets the ID of its sign-in. Existing
-- rows take the ID of the first session of their rotation chain (following
-- rotatedFromId back to the login), so a chain keeps one session ID.
ALTER TABLE "RefreshSession" ADD COLUMN     "sessionId" TEXT;

WITH RECURSIVE chain AS (
  SELECT "id", "id" AS "rootId"
  FROM "RefreshSession"
  WHERE "rotatedFromId" IS NULL
  UNION ALL
  SELECT child."id", chain."rootId"
  FROM "RefreshSession" child
  JOIN chain ON child."rotatedFromId" = chain."id"
)
UPDATE "RefreshSession" session
SET "sessionId" = chain."rootId"
FROM chain
WHERE session."id" = chain."id";

-- Rows whose chain start was already deleted form their own session.
UPDATE "RefreshSession" SET "sessionId" = "id" WHERE "sessionId" IS NULL;

ALTER TABLE "RefreshSession" ALTER COLUMN "sessionId" SET NOT NULL;

-- CreateTable
CREATE TABLE "StepUpApproval" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "action" "StepUpAction" NOT NULL,
    "method" "StepUpMethod" NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "StepUpApproval_pkey" PRIMARY KEY ("id"),
    -- Only a SHA-256 (lowercase hex) of the approval token is stored.
    CONSTRAINT "StepUpApproval_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    -- An approval is valid for at most 10 minutes.
    CONSTRAINT "StepUpApproval_expiresAt_check"
      CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes')
);

-- CreateTable
CREATE TABLE "StepUpChallenge" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "action" "StepUpAction" NOT NULL,
    "stateHash" CHAR(64) NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "redirectUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "StepUpChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StepUpChallenge_stateHash_check" CHECK ("stateHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "StepUpChallenge_expiresAt_check"
      CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes')
);

-- CreateIndex
CREATE UNIQUE INDEX "StepUpApproval_tokenHash_key" ON "StepUpApproval"("tokenHash");

-- CreateIndex
CREATE INDEX "StepUpApproval_authId_sessionId_action_idx" ON "StepUpApproval"("authId", "sessionId", "action");

-- CreateIndex
CREATE INDEX "StepUpApproval_expiresAt_idx" ON "StepUpApproval"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "StepUpChallenge_stateHash_key" ON "StepUpChallenge"("stateHash");

-- CreateIndex
CREATE INDEX "StepUpChallenge_authId_idx" ON "StepUpChallenge"("authId");

-- CreateIndex
CREATE INDEX "StepUpChallenge_expiresAt_idx" ON "StepUpChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "RefreshSession_sessionId_idx" ON "RefreshSession"("sessionId");

-- AddForeignKey
ALTER TABLE "StepUpApproval" ADD CONSTRAINT "StepUpApproval_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepUpChallenge" ADD CONSTRAINT "StepUpChallenge_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An approval's binding (user, session, action, method, token, lifetime) and a
-- challenge's binding never change, and a consumed challenge stays consumed.
-- A rotated refresh session always keeps the session ID of the session it
-- replaces, and a session ID never changes. Prisma does not model triggers;
-- they are kept in migrations only.
CREATE FUNCTION "StepUpApproval_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
    OR NEW."action" IS DISTINCT FROM OLD."action"
    OR NEW."method" IS DISTINCT FROM OLD."method"
    OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'A step-up approval cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "StepUpApproval_protect"
  BEFORE UPDATE ON "StepUpApproval"
  FOR EACH ROW EXECUTE FUNCTION "StepUpApproval_protect"();

CREATE FUNCTION "StepUpChallenge_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
    OR NEW."action" IS DISTINCT FROM OLD."action"
    OR NEW."stateHash" IS DISTINCT FROM OLD."stateHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'A step-up challenge cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."consumedAt" IS NOT NULL
    AND NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt" THEN
    RAISE EXCEPTION 'A used step-up challenge cannot be reused'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "StepUpChallenge_protect"
  BEFORE UPDATE ON "StepUpChallenge"
  FOR EACH ROW EXECUTE FUNCTION "StepUpChallenge_protect"();

CREATE FUNCTION "RefreshSession_keep_session"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_session TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."sessionId" IS DISTINCT FROM OLD."sessionId" THEN
      RAISE EXCEPTION 'A refresh session cannot move to another session'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."rotatedFromId" IS NOT NULL THEN
    EXECUTE format(
      'SELECT "sessionId" FROM %I."RefreshSession" WHERE "id" = $1',
      TG_TABLE_SCHEMA
    ) INTO parent_session USING NEW."rotatedFromId";
    IF parent_session IS NOT NULL AND parent_session <> NEW."sessionId" THEN
      RAISE EXCEPTION 'A rotated refresh session must keep its session ID'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "RefreshSession_keep_session"
  BEFORE INSERT OR UPDATE ON "RefreshSession"
  FOR EACH ROW EXECUTE FUNCTION "RefreshSession_keep_session"();
