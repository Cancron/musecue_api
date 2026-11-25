-- Monthly Pro credits: SUBSCRIPTION allocations are linked to the paid Pro
-- period that funded them (subscription, payment, period start; the period
-- end is expiresAt), one allocation per payment.
--
-- The database, not only the application, guarantees that subscription
-- credits exist only for a SUCCEEDED payment of the same user's subscription
-- and exactly for its billing period. Existing SUBSCRIPTION allocations
-- without a payment would violate the new CHECK; none are created by the
-- application before this migration (nothing allocated them yet).

-- AlterTable
ALTER TABLE "CreditAllocation" ADD COLUMN     "paymentId" TEXT,
ADD COLUMN     "periodStartsAt" TIMESTAMP(3),
ADD COLUMN     "subscriptionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CreditAllocation_paymentId_key" ON "CreditAllocation"("paymentId");

-- CreateIndex
CREATE INDEX "CreditAllocation_subscriptionId_idx" ON "CreditAllocation"("subscriptionId");

-- AddForeignKey
ALTER TABLE "CreditAllocation" ADD CONSTRAINT "CreditAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SUBSCRIPTION allocations carry their paid period; other sources never do.
ALTER TABLE "CreditAllocation"
  ADD CONSTRAINT "CreditAllocation_subscription_period_link" CHECK (
    ("source" = 'SUBSCRIPTION' AND "subscriptionId" IS NOT NULL AND "paymentId" IS NOT NULL AND "periodStartsAt" IS NOT NULL)
    OR ("source" <> 'SUBSCRIPTION' AND "subscriptionId" IS NULL AND "paymentId" IS NULL AND "periodStartsAt" IS NULL)
  );

-- At insert, a SUBSCRIPTION allocation must match its payment: SUCCEEDED, of
-- the same subscription, whose user owns the wallet, and exactly its period.
CREATE FUNCTION "CreditAllocation_check_subscription_payment"() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  paid RECORD;
  wallet_owner text;
BEGIN
  IF NEW."source" <> 'SUBSCRIPTION' THEN
    RETURN NEW;
  END IF;
  SELECT p."status", p."subscriptionId", p."periodStart", p."periodEnd", s."authId"
    INTO paid
    FROM "PaymentTransaction" p
    LEFT JOIN "UserSubscription" s ON s."id" = p."subscriptionId"
    WHERE p."id" = NEW."paymentId";
  IF NOT FOUND OR paid."status" <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'Subscription credits require a succeeded payment'
      USING ERRCODE = 'check_violation';
  END IF;
  IF paid."subscriptionId" IS DISTINCT FROM NEW."subscriptionId" THEN
    RAISE EXCEPTION 'The payment does not belong to this subscription'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "authId" INTO wallet_owner FROM "CreditWallet" WHERE "id" = NEW."walletId";
  IF paid."authId" IS DISTINCT FROM wallet_owner THEN
    RAISE EXCEPTION 'The subscription belongs to another user'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."periodStartsAt" <> paid."periodStart" OR NEW."expiresAt" IS DISTINCT FROM paid."periodEnd" THEN
    RAISE EXCEPTION 'Subscription credits must cover exactly the paid period'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CreditAllocation_check_subscription_payment" BEFORE INSERT ON "CreditAllocation"
  FOR EACH ROW EXECUTE FUNCTION "CreditAllocation_check_subscription_payment"();

-- The period links are allocation terms: immutable like the others.
CREATE OR REPLACE FUNCTION "Credit_protect_history"() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  owner_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- During a cascade the owner row is already gone.
    IF TG_TABLE_NAME = 'CreditWallet' THEN
      SELECT EXISTS (SELECT 1 FROM "authUser" WHERE "id" = OLD."authId") INTO owner_exists;
    ELSE
      SELECT EXISTS (SELECT 1 FROM "CreditWallet" WHERE "id" = OLD."walletId") INTO owner_exists;
    END IF;
    IF owner_exists THEN
      RAISE EXCEPTION '% rows cannot be deleted while their owner exists', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_TABLE_NAME IN ('CreditTransaction', 'CreditTransactionEntry') THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;

  IF TG_TABLE_NAME = 'CreditWallet' THEN
    IF NEW."id" <> OLD."id" OR NEW."authId" <> OLD."authId" THEN
      RAISE EXCEPTION 'A credit wallet cannot move to another user' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'CreditAllocation' THEN
    IF NEW."id" <> OLD."id" OR NEW."walletId" <> OLD."walletId" OR NEW."source" <> OLD."source"
       OR NEW."sourceReference" <> OLD."sourceReference" OR NEW."grantedCredits" <> OLD."grantedCredits"
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."grantedAt" <> OLD."grantedAt"
       OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
       OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
       OR NEW."periodStartsAt" IS DISTINCT FROM OLD."periodStartsAt" THEN
      RAISE EXCEPTION 'Credit allocation terms cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."remainingCredits" > OLD."remainingCredits" THEN
      RAISE EXCEPTION 'Remaining credits of an allocation cannot increase' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."expiredAt" IS NOT NULL AND NEW."expiredAt" IS DISTINCT FROM OLD."expiredAt" THEN
      RAISE EXCEPTION 'The expiry of an allocation cannot be changed once recorded' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'CreditSessionOverage' THEN
    IF NEW."id" <> OLD."id" OR NEW."walletId" <> OLD."walletId" OR NEW."sessionId" <> OLD."sessionId"
       OR NEW."limitCredits" <> OLD."limitCredits" THEN
      RAISE EXCEPTION 'Session overage terms cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."overageCredits" < OLD."overageCredits" OR NEW."settledCredits" < OLD."settledCredits" THEN
      RAISE EXCEPTION 'Session overage and its settlement cannot decrease' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
