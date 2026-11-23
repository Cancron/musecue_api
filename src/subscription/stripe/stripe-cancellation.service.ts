import { HttpException, Injectable } from '@nestjs/common';
import { SubscriptionEventType, type UserSubscription } from '@prisma/client';
import Stripe from 'stripe';
import AppError from '../../common/errors/app.error';
import {
  ActivityLogService,
  type ActivityLogMetadata,
} from '../../common/services/activity-log.service';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import type { SubscriptionCancellationView } from '../interfaces/cancellation.interface';
import {
  isProActive,
  resolveSubscriptionAccess,
} from '../subscription-access.policy';
import {
  type ProviderSubscriptionCancellation,
  STRIPE_PROVIDER,
  StripeGateway,
} from './stripe.gateway';

/** Payment work can wait for row locks under load. */
const PAYMENT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

const LOG_CONTEXT = 'StripeCancellationService';

export const CANCELLATION_ERRORS = {
  noActiveSubscription: () =>
    AppError.conflict(
      'You do not have an active paid Pro subscription to cancel',
    ),
  notConfigured: () =>
    AppError.serviceUnavailable('Payments are not configured'),
  // Stripe may have canceled even when its response was lost, so the
  // outcome is unknown: never claim the subscription is still renewing.
  failed: () =>
    AppError.serviceUnavailable(
      'Cancellation could not be confirmed; please retry or check subscription status',
    ),
  changed: () =>
    AppError.conflict('The subscription changed; refresh before trying again'),
};

/** The result of recording a cancellation that Stripe confirmed. */
export type CancellationOutcome =
  | { outcome: 'CANCELED'; record: UserSubscription }
  | { outcome: 'ALREADY_CANCELED'; record: UserSubscription }
  /** The record no longer backs this Stripe subscription (or has no term). */
  | { outcome: 'NOT_LINKED'; record: UserSubscription };

/**
 * Cancels the caller's own paid subscription at the end of its period.
 *
 * - The user comes only from the access token; a subscription is found
 *   through the caller's own UserSubscription, so nobody can cancel another
 *   user's subscription.
 * - Only an active paid term backed by a Stripe subscription can be canceled,
 *   and only at the end of the period: Pro access continues until
 *   proExpiresAt, auto-renewal is turned off, and proExpiresAt never changes.
 * - Stripe is asked first, outside any database transaction. The
 *   cancellation is saved only after Stripe responds positively
 *   (`cancel_at_period_end`). Without that response the outcome is unknown
 *   (Stripe may have canceled and the response been lost), so nothing is
 *   saved and the caller is told to retry or check the status. A retry, or
 *   Stripe's `customer.subscription.updated` webhook, records it then.
 * - Recording is idempotent and serialized by the UserSubscription row lock:
 *   proCanceledAt is set only while it is empty, with exactly one CANCELED
 *   event. Repeated requests and Stripe webhooks
 *   (`customer.subscription.updated`) find it recorded and change nothing.
 */
@Injectable()
export class StripeCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeGateway,
    private readonly activityLog: ActivityLogService,
    private readonly logger: CustomLoggerService,
  ) {}

  async cancelAtPeriodEnd(
    authId: string,
    metadata: ActivityLogMetadata,
    now: Date = new Date(),
  ): Promise<SubscriptionCancellationView> {
    const record = await this.prisma.userSubscription.findUnique({
      where: { authId },
    });
    if (
      !record ||
      !isProActive(record, now) ||
      record.paymentProvider !== STRIPE_PROVIDER ||
      !record.providerSubscriptionId ||
      !record.proExpiresAt
    ) {
      throw CANCELLATION_ERRORS.noActiveSubscription();
    }
    // A repeated request: already canceled, nothing to ask Stripe.
    if (record.proCanceledAt) return this.toView(record, true, now);
    if (!this.stripe.apiConfigured) throw CANCELLATION_ERRORS.notConfigured();

    const subscriptionId = record.providerSubscriptionId;
    let remote: ProviderSubscriptionCancellation;
    try {
      remote = await this.stripe.cancelAtPeriodEnd(
        subscriptionId,
        record.proExpiresAt,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logStripeError(record.id, error);
      throw CANCELLATION_ERRORS.failed();
    }
    if (remote.id !== subscriptionId || !remote.cancelAtPeriodEnd) {
      this.logger.logWithMetadata(
        'error',
        'Stripe did not confirm the cancellation; nothing recorded',
        {
          context: LOG_CONTEXT,
          subscriptionId: record.id,
          providerStatus: remote.status,
          cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
        },
      );
      throw CANCELLATION_ERRORS.failed();
    }

    const result = await this.recordCancellation(
      record.id,
      subscriptionId,
      remote.canceledAt ?? now,
      { ...metadata, actionedBy: authId },
    );
    if (result.outcome === 'NOT_LINKED') throw CANCELLATION_ERRORS.changed();
    return this.toView(
      result.record,
      result.outcome === 'ALREADY_CANCELED',
      now,
    );
  }

  /**
   * Records a cancellation that Stripe confirmed for `providerSubscriptionId`
   * (from a user request or a webhook). Idempotent and safe under concurrency:
   * only the first writer sets proCanceledAt and adds the CANCELED event; the
   * paid term and its expiry are never changed.
   */
  recordCancellation(
    subscriptionRecordId: string,
    providerSubscriptionId: string,
    canceledAt: Date,
    metadata: ActivityLogMetadata,
  ): Promise<CancellationOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "UserSubscription" WHERE "id" = ${subscriptionRecordId} FOR UPDATE
      `;
      const record = await tx.userSubscription.findUniqueOrThrow({
        where: { id: subscriptionRecordId },
      });
      if (
        record.paymentProvider !== STRIPE_PROVIDER ||
        record.providerSubscriptionId !== providerSubscriptionId ||
        record.proStartedAt === null
      ) {
        return { outcome: 'NOT_LINKED', record };
      }
      if (record.proCanceledAt !== null) {
        return { outcome: 'ALREADY_CANCELED', record };
      }

      const claimed = await tx.userSubscription.updateMany({
        where: { id: record.id, proCanceledAt: null },
        data: { proCanceledAt: canceledAt },
      });
      if (claimed.count !== 1) {
        return {
          outcome: 'ALREADY_CANCELED',
          record: await tx.userSubscription.findUniqueOrThrow({
            where: { id: record.id },
          }),
        };
      }
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: record.id,
          type: SubscriptionEventType.CANCELED,
          occurredAt: canceledAt,
        },
      });
      await this.activityLog.logActivity(
        {
          tableName: 'UserSubscription',
          recordId: record.id,
          action: 'update',
          changes: [
            {
              fieldName: 'proCanceledAt',
              oldValue: null,
              newValue: canceledAt.toISOString(),
            },
          ],
          metadata,
        },
        tx,
      );
      return {
        outcome: 'CANCELED',
        record: { ...record, proCanceledAt: canceledAt },
      };
    }, PAYMENT_TRANSACTION_OPTIONS);
  }

  private toView(
    record: UserSubscription,
    alreadyCanceled: boolean,
    now: Date,
  ): SubscriptionCancellationView {
    const access = resolveSubscriptionAccess(record, now);
    return {
      status: access.status,
      hasProAccess: access.hasProAccess,
      autoRenew: false,
      canceledAt: (record.proCanceledAt as Date).toISOString(),
      endsAt: (record.proExpiresAt as Date).toISOString(),
      accessExpiresAt: access.accessExpiresAt?.toISOString() ?? null,
      alreadyCanceled,
    };
  }

  /** Logs allowlisted Stripe error fields only (messages can contain PII). */
  private logStripeError(subscriptionRecordId: string, error: unknown) {
    const stripeError =
      error instanceof Stripe.errors.StripeError ? error : null;
    this.logger.logWithMetadata('warn', 'Stripe cancellation failed', {
      context: LOG_CONTEXT,
      subscriptionId: subscriptionRecordId,
      errorType:
        stripeError?.type ??
        (error instanceof Error ? error.name : typeof error),
      rawType: stripeError?.rawType,
      code: stripeError?.code,
      statusCode: stripeError?.statusCode,
      requestId: stripeError?.requestId,
    });
  }
}
