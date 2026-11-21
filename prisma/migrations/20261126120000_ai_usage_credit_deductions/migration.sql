-- AI usage metering and credit deductions (see prisma/schema/credit.prisma,
-- AiUsage). Every AI provider request the provider reported usage for is
-- recorded with its user, makeup session, run, tokens and cost in USD; a run
-- is charged once, for the request that produced its result, at
-- cost / rate rounded up to the configured step. The DEBIT transaction keeps
-- the cost and the rate in force, so later rate changes never alter history.

-- CreateEnum
CREATE TYPE "AiUsageOutcome" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiUsageChargeStatus" AS ENUM ('PENDING', 'CHARGED', 'NOT_CHARGED', 'UNCOLLECTED');

-- AlterTable
ALTER TABLE "CreditSettings" ADD COLUMN     "deductionStepMicroCredits" INTEGER NOT NULL DEFAULT 1000000;

-- AlterTable
ALTER TABLE "CreditTransaction" ADD COLUMN     "creditCostUsdMicros" INTEGER,
ADD COLUMN     "usageCostUsd" DECIMAL(20,10);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "sessionId" VARCHAR(64) NOT NULL,
    "runId" VARCHAR(64) NOT NULL,
    "operation" "AiOperation" NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "model" VARCHAR(255) NOT NULL,
    "providerRequestId" VARCHAR(255),
    "outcome" "AiUsageOutcome" NOT NULL,
    "errorCode" VARCHAR(100),
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "totalTokens" INTEGER NOT NULL,
    "costUsd" DECIMAL(20,10),
    "chargeStatus" "AiUsageChargeStatus" NOT NULL DEFAULT 'PENDING',
    "chargeNote" VARCHAR(50),
    "creditCostUsdMicros" INTEGER,
    "creditsExact" DECIMAL(30,12),
    "creditsDue" DECIMAL(18,6),
    "creditsCharged" DECIMAL(18,6),
    "transactionId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiUsage_transactionId_key" ON "AiUsage"("transactionId");

-- CreateIndex
CREATE INDEX "AiUsage_sessionId_occurredAt_idx" ON "AiUsage"("sessionId", "occurredAt");

-- CreateIndex
CREATE INDEX "AiUsage_authId_occurredAt_idx" ON "AiUsage"("authId", "occurredAt");

-- CreateIndex
CREATE INDEX "AiUsage_runId_idx" ON "AiUsage"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsage_provider_providerRequestId_key" ON "AiUsage"("provider", "providerRequestId");

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "CreditTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "CreditSettings"
  ADD CONSTRAINT "CreditSettings_deductionStepMicroCredits_positive" CHECK ("deductionStepMicroCredits" > 0);

ALTER TABLE "CreditTransaction"
  ADD CONSTRAINT "CreditTransaction_usage_cost" CHECK (
    ("usageCostUsd" IS NULL) = ("creditCostUsdMicros" IS NULL)
    AND (
      "usageCostUsd" IS NULL
      OR ("type" = 'DEBIT' AND "usageCostUsd" >= 0 AND "creditCostUsdMicros" > 0)
    )
  );

ALTER TABLE "AiUsage"
  ADD CONSTRAINT "AiUsage_tokens_non_negative" CHECK (
    "inputTokens" >= 0 AND "outputTokens" >= 0 AND "totalTokens" >= 0
  ),
  ADD CONSTRAINT "AiUsage_cost_non_negative" CHECK ("costUsd" IS NULL OR "costUsd" >= 0),
  ADD CONSTRAINT "AiUsage_charge_fields" CHECK (
    -- A failed request is never charged.
    ("outcome" = 'SUCCEEDED' OR "chargeStatus" = 'NOT_CHARGED')
    -- Charged and uncollected usage keep the rate and the credits.
    AND ("chargeStatus" NOT IN ('CHARGED', 'UNCOLLECTED') OR (
      "creditCostUsdMicros" > 0 AND "creditsExact" >= 0
      AND "creditsDue" > 0 AND "creditsCharged" >= 0
      AND "creditsCharged" <= "creditsDue"
    ))
    AND ("chargeStatus" <> 'CHARGED' OR (
      "transactionId" IS NOT NULL AND "creditsCharged" = "creditsDue"
    ))
    AND ("chargeStatus" <> 'UNCOLLECTED' OR "creditsCharged" < "creditsDue")
    AND ("chargeStatus" IN ('CHARGED', 'UNCOLLECTED') OR "transactionId" IS NULL)
    AND ("chargeStatus" IN ('PENDING', 'CHARGED') OR "chargeNote" IS NOT NULL)
  );

-- Usage facts never change; the charge is written once (from PENDING); rows
-- are only deleted together with their user.
CREATE FUNCTION "AiUsage_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."authUser" WHERE "id" = $1)',
      TG_TABLE_SCHEMA
    ) INTO owner_exists USING OLD."authId";
    IF owner_exists THEN
      RAISE EXCEPTION 'AiUsage history cannot be deleted while its user exists'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
    OR NEW."runId" IS DISTINCT FROM OLD."runId"
    OR NEW."operation" IS DISTINCT FROM OLD."operation"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."model" IS DISTINCT FROM OLD."model"
    OR NEW."providerRequestId" IS DISTINCT FROM OLD."providerRequestId"
    OR NEW."outcome" IS DISTINCT FROM OLD."outcome"
    OR NEW."errorCode" IS DISTINCT FROM OLD."errorCode"
    OR NEW."inputTokens" IS DISTINCT FROM OLD."inputTokens"
    OR NEW."outputTokens" IS DISTINCT FROM OLD."outputTokens"
    OR NEW."totalTokens" IS DISTINCT FROM OLD."totalTokens"
    OR NEW."costUsd" IS DISTINCT FROM OLD."costUsd"
    OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'AiUsage facts cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."chargeStatus" <> 'PENDING' AND (
    NEW."chargeStatus" IS DISTINCT FROM OLD."chargeStatus"
    OR NEW."chargeNote" IS DISTINCT FROM OLD."chargeNote"
    OR NEW."creditCostUsdMicros" IS DISTINCT FROM OLD."creditCostUsdMicros"
    OR NEW."creditsExact" IS DISTINCT FROM OLD."creditsExact"
    OR NEW."creditsDue" IS DISTINCT FROM OLD."creditsDue"
    OR NEW."creditsCharged" IS DISTINCT FROM OLD."creditsCharged"
    OR NEW."transactionId" IS DISTINCT FROM OLD."transactionId"
  ) THEN
    RAISE EXCEPTION 'AiUsage charge was already recorded (%)', OLD."chargeStatus"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiUsage_protect"
  BEFORE UPDATE OR DELETE ON "AiUsage"
  FOR EACH ROW EXECUTE FUNCTION "AiUsage_protect"();
