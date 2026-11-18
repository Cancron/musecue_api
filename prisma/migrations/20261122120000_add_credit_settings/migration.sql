-- Administrator-managed AI credit configuration (single row, id = 1).
-- No row is inserted: until an administrator saves a change, the API serves
-- the defaults from src/credits/credit-settings.constants.ts, which match the
-- column defaults below, and the first save creates the row from them.
-- Configuration only: no credits are granted, deducted or enforced yet.

-- CreateTable
CREATE TABLE "CreditSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "trialCredits" INTEGER NOT NULL DEFAULT 50,
    "proMonthlyCredits" INTEGER NOT NULL DEFAULT 1000,
    "creditCostUsdMicros" INTEGER NOT NULL DEFAULT 5000,
    "sessionOverageCredits" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditSettings_pkey" PRIMARY KEY ("id")
);

-- Database-level invariants (not expressible in the Prisma schema). Request
-- validation enforces the stricter product bounds; these only guarantee that
-- no write path can persist a second row, a negative allowance, or a zero
-- credit cost (which would make converting OpenRouter costs impossible).
ALTER TABLE "CreditSettings"
  ADD CONSTRAINT "CreditSettings_single_row" CHECK ("id" = 1),
  ADD CONSTRAINT "CreditSettings_trialCredits_positive" CHECK ("trialCredits" > 0),
  ADD CONSTRAINT "CreditSettings_proMonthlyCredits_positive" CHECK ("proMonthlyCredits" > 0),
  ADD CONSTRAINT "CreditSettings_creditCostUsdMicros_positive" CHECK ("creditCostUsdMicros" > 0),
  ADD CONSTRAINT "CreditSettings_sessionOverageCredits_non_negative" CHECK ("sessionOverageCredits" >= 0);
