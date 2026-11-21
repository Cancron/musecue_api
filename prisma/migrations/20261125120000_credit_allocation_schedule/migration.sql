-- The months of Pro credits each successful payment entitles its user to,
-- allocated one month at a time (see prisma/schema/credit.prisma,
-- CreditAllocationSchedule). A monthly payment has one month (its billing
-- period); a yearly payment twelve, counted from its start on the same day
-- (clamped: Jan 31 -> Feb 28 -> Mar 31), the last one ending with the paid
-- period.
--
-- Guarantees:
--   * one row per payment and month, one row per allocation;
--   * status only moves forward: PENDING -> ALLOCATED | SKIPPED;
--   * an ALLOCATED row is linked to the allocation for exactly its payment,
--     month and user; a SKIPPED row says why;
--   * a row's payment, month and owner never change.

-- CreateEnum
CREATE TYPE "CreditScheduleStatus" AS ENUM ('PENDING', 'ALLOCATED', 'SKIPPED');

-- CreateTable
CREATE TABLE "CreditAllocationSchedule" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "CreditScheduleStatus" NOT NULL DEFAULT 'PENDING',
    "allocationId" TEXT,
    "skipReason" VARCHAR(50),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(255),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditAllocationSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditAllocationSchedule_allocationId_key" ON "CreditAllocationSchedule"("allocationId");

-- CreateIndex
CREATE INDEX "CreditAllocationSchedule_status_periodStart_idx" ON "CreditAllocationSchedule"("status", "periodStart");

-- CreateIndex
CREATE INDEX "CreditAllocationSchedule_authId_status_idx" ON "CreditAllocationSchedule"("authId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CreditAllocationSchedule_paymentId_periodStart_key" ON "CreditAllocationSchedule"("paymentId", "periodStart");

-- AddForeignKey
ALTER TABLE "CreditAllocationSchedule" ADD CONSTRAINT "CreditAllocationSchedule_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditAllocationSchedule" ADD CONSTRAINT "CreditAllocationSchedule_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditAllocationSchedule" ADD CONSTRAINT "CreditAllocationSchedule_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "CreditAllocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "CreditAllocationSchedule"
  ADD CONSTRAINT "CreditAllocationSchedule_period" CHECK ("periodStart" < "periodEnd"),
  ADD CONSTRAINT "CreditAllocationSchedule_status_fields" CHECK (
    ("status" = 'ALLOCATED') = ("allocationId" IS NOT NULL)
    AND ("status" = 'SKIPPED') = ("skipReason" IS NOT NULL)
    AND ("status" = 'PENDING') = ("processedAt" IS NULL)
  ),
  ADD CONSTRAINT "CreditAllocationSchedule_attempts_non_negative" CHECK ("attempts" >= 0);

CREATE FUNCTION "CreditAllocationSchedule_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_payment text;
  v_period_start timestamp(3);
  v_owner text;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
    OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
    OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
    OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'CreditAllocationSchedule payment and month cannot change'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" <> 'PENDING' AND (
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."allocationId" IS DISTINCT FROM OLD."allocationId"
    OR NEW."skipReason" IS DISTINCT FROM OLD."skipReason"
    OR NEW."processedAt" IS DISTINCT FROM OLD."processedAt"
  ) THEN
    RAISE EXCEPTION 'CreditAllocationSchedule month was already %', OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'ALLOCATED' AND OLD."status" = 'PENDING' THEN
    EXECUTE format(
      'SELECT "paymentId", "periodStart", "authId" FROM %I."CreditAllocation" WHERE "id" = $1',
      TG_TABLE_SCHEMA
    ) INTO v_payment, v_period_start, v_owner USING NEW."allocationId";
    IF v_payment IS DISTINCT FROM NEW."paymentId"
      OR v_period_start IS DISTINCT FROM NEW."periodStart"
      OR v_owner IS DISTINCT FROM NEW."authId" THEN
      RAISE EXCEPTION 'CreditAllocationSchedule month must be linked to its own allocation'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditAllocationSchedule_protect"
  BEFORE UPDATE ON "CreditAllocationSchedule"
  FOR EACH ROW EXECUTE FUNCTION "CreditAllocationSchedule_protect"();

-- Payments recorded before this migration: schedule the months that have not
-- ended of every successful payment that created or renewed a paid term.
INSERT INTO "CreditAllocationSchedule"
  ("id", "authId", "subscriptionId", "paymentId", "periodStart", "periodEnd", "updatedAt")
SELECT gen_random_uuid()::text, s."authId", p."subscriptionId", p."id", m."start", m."end", CURRENT_TIMESTAMP
FROM "PaymentTransaction" p
JOIN "UserSubscription" s ON s."id" = p."subscriptionId"
JOIN "SubscriptionEvent" e ON e."paymentId" = p."id" AND e."type" IN ('CREATED', 'RENEWED')
CROSS JOIN LATERAL (
  SELECT
    p."periodStart" + make_interval(months => k) AS "start",
    CASE
      WHEN p."billingInterval" = 'MONTHLY' THEN p."periodEnd"
      ELSE LEAST(p."periodStart" + make_interval(months => k + 1), p."periodEnd")
    END AS "end"
  FROM generate_series(0, CASE WHEN p."billingInterval" = 'YEARLY' THEN 11 ELSE 0 END) AS k
) m
WHERE p."status" = 'SUCCEEDED'
  AND m."start" < p."periodEnd"
  AND m."end" > CURRENT_TIMESTAMP;

-- Months that already have their credits (allocated by the earlier releases)
-- are marked ALLOCATED; the earliest overlapping allocation of the same
-- payment is linked.
UPDATE "CreditAllocationSchedule" c
SET "status" = 'ALLOCATED', "allocationId" = a."allocationId", "processedAt" = a."grantedAt"
FROM (
  SELECT DISTINCT ON (c2."id") c2."id" AS "scheduleId", a2."id" AS "allocationId", a2."grantedAt"
  FROM "CreditAllocationSchedule" c2
  JOIN "CreditAllocation" a2
    ON a2."paymentId" = c2."paymentId"
   AND a2."periodStart" = c2."periodStart"
  ORDER BY c2."id", a2."grantedAt"
) a
WHERE c."id" = a."scheduleId";
