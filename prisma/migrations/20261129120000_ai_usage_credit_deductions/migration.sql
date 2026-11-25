-- AI usage tracking and credit deductions by the provider's actual cost:
-- one AiUsage row per AI provider request (tokens and usage.cost in US
-- dollars, tied to the user, makeup session and AI run), and the USD cost
-- and conversion rate on each AI deduction in the credit ledger.

-- CreateEnum
CREATE TYPE "AiUsageChargeStatus" AS ENUM ('PENDING', 'CHARGED', 'FREE', 'NOT_CHARGED', 'INSUFFICIENT_CREDITS');

-- AlterTable
ALTER TABLE "CreditTransaction" ADD COLUMN     "costUsd" DECIMAL(24,12),
ADD COLUMN     "usdMicrosPerCredit" INTEGER;

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "aiRunId" TEXT NOT NULL,
    "operation" "AiOperation" NOT NULL,
    "attempt" INTEGER NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "model" VARCHAR(200),
    "providerRequestId" VARCHAR(200),
    "succeeded" BOOLEAN NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "costUsd" DECIMAL(24,12),
    "chargeStatus" "AiUsageChargeStatus" NOT NULL DEFAULT 'PENDING',
    "creditTransactionId" TEXT,
    "chargedCredits" DECIMAL(20,6),
    "usdMicrosPerCredit" INTEGER,
    "chargedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiUsage_creditTransactionId_key" ON "AiUsage"("creditTransactionId");

-- CreateIndex
CREATE INDEX "AiUsage_sessionId_createdAt_idx" ON "AiUsage"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsage_aiRunId_idx" ON "AiUsage"("aiRunId");

-- CreateIndex
CREATE INDEX "AiUsage_authId_createdAt_idx" ON "AiUsage"("authId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsage_provider_providerRequestId_key" ON "AiUsage"("provider", "providerRequestId");

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_creditTransactionId_fkey" FOREIGN KEY ("creditTransactionId") REFERENCES "CreditTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- An AI deduction charges exactly its cost at the recorded rate:
-- credits = round(costUsd * 1e6 / usdMicrosPerCredit, 6). The rate is a
-- snapshot, so changing the settings never alters historical deductions.
ALTER TABLE "CreditTransaction"
  ADD CONSTRAINT "CreditTransaction_cost_conversion" CHECK (
    ("costUsd" IS NULL AND "usdMicrosPerCredit" IS NULL)
    OR ("type" = 'DEDUCTION' AND "costUsd" > 0 AND "usdMicrosPerCredit" > 0
        AND ("overageChangeCredits" - "amountCredits")
            = round("costUsd" * 1000000 / "usdMicrosPerCredit", 6))
  );

ALTER TABLE "AiUsage"
  ADD CONSTRAINT "AiUsage_measurements_non_negative" CHECK (
    "attempt" >= 1
    AND ("inputTokens" IS NULL OR "inputTokens" >= 0)
    AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
    AND ("totalTokens" IS NULL OR "totalTokens" >= 0)
    AND ("costUsd" IS NULL OR "costUsd" >= 0)
  ),
  ADD CONSTRAINT "AiUsage_charge_recorded" CHECK (
    ("chargeStatus" = 'CHARGED'
      AND "chargedCredits" > 0 AND "usdMicrosPerCredit" > 0 AND "chargedAt" IS NOT NULL)
    OR ("chargeStatus" <> 'CHARGED' AND "creditTransactionId" IS NULL AND "chargedCredits" IS NULL)
  );

-- Usage is recorded for the AI run it served: the run must belong to the
-- same user and makeup session.
CREATE FUNCTION "AiUsage_check_run"() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "AiRun"
    WHERE "id" = NEW."aiRunId" AND "authId" = NEW."authId" AND "sessionId" = NEW."sessionId"
  ) THEN
    RAISE EXCEPTION 'AI usage must belong to its run''s user and makeup session'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiUsage_check_run" BEFORE INSERT ON "AiUsage"
  FOR EACH ROW EXECUTE FUNCTION "AiUsage_check_run"();

-- What was measured never changes, and a charge outcome is final: only a
-- PENDING usage can be charged or closed. (Deleting the user's wallet may
-- still clear creditTransactionId through its foreign key.)
CREATE FUNCTION "AiUsage_protect"() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."authId" <> OLD."authId" OR NEW."sessionId" <> OLD."sessionId"
     OR NEW."aiRunId" <> OLD."aiRunId" OR NEW."operation" <> OLD."operation"
     OR NEW."attempt" <> OLD."attempt" OR NEW."provider" <> OLD."provider"
     OR NEW."model" IS DISTINCT FROM OLD."model"
     OR NEW."providerRequestId" IS DISTINCT FROM OLD."providerRequestId"
     OR NEW."succeeded" <> OLD."succeeded"
     OR NEW."inputTokens" IS DISTINCT FROM OLD."inputTokens"
     OR NEW."outputTokens" IS DISTINCT FROM OLD."outputTokens"
     OR NEW."totalTokens" IS DISTINCT FROM OLD."totalTokens"
     OR NEW."costUsd" IS DISTINCT FROM OLD."costUsd" THEN
    RAISE EXCEPTION 'Recorded AI usage cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."chargeStatus" <> 'PENDING' AND (
       NEW."chargeStatus" <> OLD."chargeStatus"
       OR NEW."chargedCredits" IS DISTINCT FROM OLD."chargedCredits"
       OR NEW."usdMicrosPerCredit" IS DISTINCT FROM OLD."usdMicrosPerCredit"
       OR NEW."chargedAt" IS DISTINCT FROM OLD."chargedAt"
       OR (NEW."creditTransactionId" IS NOT NULL
           AND NEW."creditTransactionId" IS DISTINCT FROM OLD."creditTransactionId")) THEN
    RAISE EXCEPTION 'The charge of an AI usage is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiUsage_protect" BEFORE UPDATE ON "AiUsage"
  FOR EACH ROW EXECUTE FUNCTION "AiUsage_protect"();
