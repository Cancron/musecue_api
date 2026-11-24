-- AI credit settings: the administrator-managed configuration of the future
-- credit system (trial allowance, Pro monthly allowance, OpenRouter cost per
-- credit and per-session overage). A single global row, created on the first
-- administrator save; until then the API serves the same defaults as the
-- column defaults below.

-- CreateTable
CREATE TABLE "CreditSettings" (
    "id" VARCHAR(20) NOT NULL DEFAULT 'default',
    "trialAllowanceCredits" INTEGER NOT NULL DEFAULT 50,
    "proMonthlyAllowanceCredits" INTEGER NOT NULL DEFAULT 1000,
    "openRouterUsdMicrosPerCredit" INTEGER NOT NULL DEFAULT 5000,
    "sessionOverageAllowanceCredits" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditSettings_pkey" PRIMARY KEY ("id")
);

-- Database-level invariants (not expressible in the Prisma schema). Request
-- validation enforces the stricter product bounds; these guarantee that no
-- write path can store a second configuration row, a negative allowance or a
-- non-positive cost per credit (which would make credit conversion divide by
-- zero).
ALTER TABLE "CreditSettings"
  ADD CONSTRAINT "CreditSettings_single_row" CHECK ("id" = 'default'),
  ADD CONSTRAINT "CreditSettings_trialAllowanceCredits_non_negative" CHECK ("trialAllowanceCredits" >= 0),
  ADD CONSTRAINT "CreditSettings_proMonthlyAllowanceCredits_non_negative" CHECK ("proMonthlyAllowanceCredits" >= 0),
  ADD CONSTRAINT "CreditSettings_openRouterUsdMicrosPerCredit_positive" CHECK ("openRouterUsdMicrosPerCredit" > 0),
  ADD CONSTRAINT "CreditSettings_sessionOverageAllowanceCredits_non_negative" CHECK ("sessionOverageAllowanceCredits" >= 0);
