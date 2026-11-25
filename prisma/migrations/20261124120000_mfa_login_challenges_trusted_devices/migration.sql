-- MFA at sign-in: login challenges and trusted devices.

-- CreateTable
CREATE TABLE "MfaLoginChallenge" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "device" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "MfaLoginChallenge_pkey" PRIMARY KEY ("id"),
    -- Only a SHA-256 hash (lowercase hex) of the token is ever stored.
    CONSTRAINT "MfaLoginChallenge_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "MfaLoginChallenge_provider_check" CHECK ("provider" IN ('local', 'google')),
    CONSTRAINT "MfaLoginChallenge_expiresAt_check" CHECK ("expiresAt" > "createdAt")
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
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "MfaTrustedDevice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MfaTrustedDevice_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    -- Trust lasts at most 30 days.
    CONSTRAINT "MfaTrustedDevice_expiresAt_check"
      CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '30 days')
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

-- A consumed challenge and a revoked device stay so, and neither can be moved
-- to another user or token: consumedAt/revokedAt are permanent once set, and
-- the owner, token hash and creation time never change. Trust cannot be
-- extended (expiresAt never moves later). Prisma does not model triggers;
-- they are kept in migrations only.
CREATE FUNCTION "MfaLoginChallenge_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'MfaLoginChallenge identity cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."consumedAt" IS NOT NULL
    AND NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt" THEN
    RAISE EXCEPTION 'A consumed MFA challenge cannot be reused'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MfaLoginChallenge_protect"
  BEFORE UPDATE ON "MfaLoginChallenge"
  FOR EACH ROW EXECUTE FUNCTION "MfaLoginChallenge_protect"();

CREATE FUNCTION "MfaTrustedDevice_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" > OLD."expiresAt" THEN
    RAISE EXCEPTION 'MfaTrustedDevice identity and expiry cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revokedAt" IS NOT NULL
    AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'A revoked trusted device cannot be restored'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MfaTrustedDevice_protect"
  BEFORE UPDATE ON "MfaTrustedDevice"
  FOR EACH ROW EXECUTE FUNCTION "MfaTrustedDevice_protect"();
