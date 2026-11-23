-- Email types and notification types of the email outbox and of credit
-- package purchase and gift notifications (in a migration of their own: a
-- new enum value cannot be used in the transaction that adds it).
ALTER TYPE "NotificationType" ADD VALUE 'GIFT_PAID';
ALTER TYPE "NotificationType" ADD VALUE 'GIFT_CANCELED';
ALTER TYPE "NotificationType" ADD VALUE 'GIFT_EXPIRED';
ALTER TYPE "NotificationType" ADD VALUE 'GIFT_UNDER_REVIEW';
ALTER TYPE "NotificationType" ADD VALUE 'GIFT_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'CREDIT_PURCHASE_COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE 'CREDIT_PURCHASE_FAILED';

ALTER TYPE "email_type" ADD VALUE 'welcome';
ALTER TYPE "email_type" ADD VALUE 'account_deletion';
ALTER TYPE "email_type" ADD VALUE 'purchase';
ALTER TYPE "email_type" ADD VALUE 'gift';
ALTER TYPE "email_type" ADD VALUE 'referral';
ALTER TYPE "email_type" ADD VALUE 'security';
