-- The email outbox: every email and its delivery history (emailHistory).
-- See prisma/schema/history.prisma.

-- DropIndex
DROP INDEX "emailHistory_messageId_idx";

-- AlterTable
ALTER TABLE "NotificationPreference" ADD COLUMN     "emailPurchases" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "emailHistory" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "notificationId" TEXT,
ADD COLUMN     "payload" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "sentAt" DROP NOT NULL,
ALTER COLUMN "sentAt" DROP DEFAULT;

-- sentAt is when SMTP accepted the email: unsent rows have none.
UPDATE "emailHistory" SET "sentAt" = NULL WHERE "emailStatus" IN ('pending', 'failed');

-- CreateIndex
CREATE UNIQUE INDEX "emailHistory_messageId_key" ON "emailHistory"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "emailHistory_notificationId_key" ON "emailHistory"("notificationId");

-- CreateIndex
CREATE INDEX "emailHistory_emailStatus_nextAttemptAt_idx" ON "emailHistory"("emailStatus", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "emailHistory" ADD CONSTRAINT "emailHistory_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Delivery facts: unsent rows (pending, failed) have no sentAt, every other
-- status has one; secrets are removed once sent; attempts never negative.
ALTER TABLE "emailHistory"
  ADD CONSTRAINT "emailHistory_delivery_facts" CHECK (
    ("emailStatus" IN ('pending', 'failed')) = ("sentAt" IS NULL)
    AND ("emailStatus" IN ('pending', 'failed') OR "payload" IS NULL)
    AND "retry_count" >= 0
  );

-- An email's identity never changes; a delivered email never becomes
-- pending or failed again, its sentAt never changes, and failed attempts
-- are never forgotten.
CREATE FUNCTION "emailHistory_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."authId" IS DISTINCT FROM OLD."authId"
    OR NEW."emailTo" IS DISTINCT FROM OLD."emailTo"
    OR NEW."emailType" IS DISTINCT FROM OLD."emailType"
    OR NEW."subject" IS DISTINCT FROM OLD."subject"
    OR NEW."messageId" IS DISTINCT FROM OLD."messageId"
    OR NEW."notificationId" IS DISTINCT FROM OLD."notificationId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."retry_count" < OLD."retry_count"
    OR (OLD."sentAt" IS NOT NULL AND NEW."sentAt" IS DISTINCT FROM OLD."sentAt")
  THEN
    RAISE EXCEPTION 'The delivery history of an email cannot be rewritten'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."emailStatus" NOT IN ('pending', 'failed') AND NEW."emailStatus" IN ('pending', 'failed') THEN
    RAISE EXCEPTION 'A delivered email cannot become % again', NEW."emailStatus"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "emailHistory_protect"
  BEFORE UPDATE ON "emailHistory"
  FOR EACH ROW EXECUTE FUNCTION "emailHistory_protect"();
