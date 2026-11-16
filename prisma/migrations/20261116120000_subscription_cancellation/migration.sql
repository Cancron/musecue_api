-- User-requested cancellation at the end of the paid period.
--
-- Cancelling sets UserSubscription.proCanceledAt (once) and appends one
-- CANCELED SubscriptionEvent; the paid term and proExpiresAt never change, so
-- Pro access continues until the period ends. The cancellation is recorded
-- with Stripe's own cancellation time, so a user request and Stripe's
-- `customer.subscription.updated` webhook describe the same instant. This
-- index makes a second CANCELED event for the same cancellation impossible
-- even if two writers raced past the application's row lock. A later
-- cancellation (another term) has a different time and is still allowed.
CREATE UNIQUE INDEX "SubscriptionEvent_one_cancellation_per_instant"
  ON "SubscriptionEvent"("subscriptionId", "occurredAt")
  WHERE "type" = 'CANCELED';
