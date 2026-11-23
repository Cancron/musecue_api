-- New enum values used by 20261209120000_credit_gifts_fulfillment (a new
-- enum value cannot be used in the transaction that adds it).
ALTER TYPE "CreditSource" ADD VALUE 'GIFT';
ALTER TYPE "NotificationType" ADD VALUE 'GIFT_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'GIFT_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE 'GIFT_DECLINED';
ALTER TYPE "NotificationType" ADD VALUE 'GIFT_DELIVERED';
