import { Injectable } from '@nestjs/common';
import {
  CreditFulfillmentStatus,
  CreditGiftStatus,
  CreditPackageOrderKind,
  CreditSource,
  type CreditFulfillment,
  type CreditGift,
  type CreditPackageOrder,
  type Prisma,
} from '@prisma/client';
import AppError from '../../common/errors/app.error';
import {
  ActivityLogService,
  type ActivityLogMetadata,
} from '../../common/services/activity-log.service';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { CreditWalletService } from '../../credits/credit-wallet.service';
import { notificationContent } from '../../notifications/notification.policy';
import { NotificationService } from '../../notifications/notification.service';
import { formatUsdCents } from '../credit-package-settings.constants';
import { packageOrderCreditReference } from '../purchases/credit-package-order.policy';
import {
  type FulfillmentHoldReason,
  fulfillmentErrorCode,
  giftCreditReference,
  MAX_FULFILLMENT_ATTEMPTS,
  recipientHoldReason,
  retryDelayMs,
} from './credit-fulfillment.policy';

/** Payment and credit work can wait for row locks under load. */
const FULFILLMENT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

const LOG_CONTEXT = 'CreditFulfillmentService';
const DUE_BATCH = 50;

/** What one processing attempt did. */
export type FulfillmentOutcome =
  | 'SUCCEEDED'
  | 'HELD'
  | 'FAILED'
  /** Not due yet (a gift's delivery time, or the retry backoff). */
  | 'NOT_DUE'
  /** Already done, or being processed by another worker right now. */
  | 'SKIPPED';

/** Holds that an administrator can approve (deliver anyway). */
const APPROVABLE: FulfillmentHoldReason[] = [
  'RECIPIENT_UNVERIFIED',
  'RECIPIENT_INACTIVE',
];

type FulfillmentWithOrder = CreditFulfillment & {
  order: CreditPackageOrder & { gift: CreditGift | null };
};

/**
 * Grants the credits of paid credit package orders: a package bought for
 * oneself (PURCHASE credits of the payer) or a gift (GIFT credits of the
 * recipient, at the gift's delivery time).
 *
 * A CreditFulfillment is written in the transaction that records the
 * verified payment (`create`), so a paid order is never lost: if the
 * process crashes before the credits are granted, the worker
 * (CreditFulfillmentWorker) finds the fulfillment at startup or on its next
 * run. Processing (`processOne`) runs in one transaction that claims the
 * row with FOR UPDATE SKIP LOCKED (a duplicate worker skips it), grants the
 * credits (unique reference per wallet and source) and marks it SUCCEEDED:
 * a crash rolls all of it back, and a finished fulfillment is never picked
 * again, so restarts, duplicate workers, duplicate or out-of-order payment
 * events and repeated attempts grant once. A failed attempt is recorded and
 * retried with backoff; after MAX_FULFILLMENT_ATTEMPTS it is FAILED until an
 * administrator retries it. A gift whose recipient cannot receive credits
 * (unverified, inactive, pending deletion or deleted) is HELD for an
 * administrator without granting anything. Every step is recorded as a
 * CreditFulfillmentEvent.
 */
@Injectable()
export class CreditFulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: CreditWalletService,
    private readonly notifications: NotificationService,
    private readonly activityLog: ActivityLogService,
    private readonly logger: CustomLoggerService,
  ) {}

  /**
   * Creates the fulfillment of an order that was just marked PAID, in the
   * same transaction. A gift payment makes the gift PAID (delivery at its
   * delivery time), unless the gift can no longer be paid (declined,
   * expired, canceled or already paid): then it is HELD.
   */
  async create(
    tx: Prisma.TransactionClient,
    order: CreditPackageOrder,
    now: Date,
  ): Promise<CreditFulfillment> {
    let data: Prisma.CreditFulfillmentUncheckedCreateInput;
    let hold: FulfillmentHoldReason | null = null;
    if (order.kind === CreditPackageOrderKind.SELF) {
      hold = order.authId ? null : 'RECIPIENT_DELETED';
      data = {
        orderId: order.id,
        kind: CreditPackageOrderKind.SELF,
        recipientAuthId: order.authId,
        source: CreditSource.PURCHASE,
        creditReference: packageOrderCreditReference(order.id),
        credits: order.credits,
        dueAt: now,
        nextAttemptAt: now,
      };
    } else {
      const gift = await this.lockGift(tx, order.giftId as string);
      if (gift.status === CreditGiftStatus.ACCEPTED) {
        await tx.creditGift.update({
          where: { id: gift.id },
          data: { status: CreditGiftStatus.PAID, paidAt: now },
        });
        if (gift.senderAuthId) {
          await this.notifications.notify(
            tx,
            gift.senderAuthId,
            `gift-paid:${gift.id}`,
            notificationContent.giftPaid(
              gift.id,
              await this.usernameOf(tx, gift.recipientAuthId),
              gift.credits,
              gift.deliverAt,
              gift.deliverAt.getTime() <= now.getTime(),
            ),
          );
        }
      } else {
        hold =
          gift.status === CreditGiftStatus.PAID ||
          gift.status === CreditGiftStatus.DELIVERED ||
          gift.status === CreditGiftStatus.REVIEW ||
          gift.status === CreditGiftStatus.REJECTED
            ? 'GIFT_ALREADY_PAID'
            : 'GIFT_NOT_PAYABLE';
      }
      const dueAt =
        gift.deliverAt.getTime() > now.getTime() ? gift.deliverAt : now;
      data = {
        orderId: order.id,
        kind: CreditPackageOrderKind.GIFT,
        recipientAuthId: gift.recipientAuthId,
        source: CreditSource.GIFT,
        creditReference: giftCreditReference(gift.id),
        credits: gift.credits,
        dueAt,
        nextAttemptAt: dueAt,
      };
    }
    const fulfillment = await tx.creditFulfillment.create({
      data: {
        ...data,
        ...(hold
          ? { status: CreditFulfillmentStatus.HELD, holdReason: hold }
          : {}),
      },
    });
    await this.event(tx, fulfillment.id, 'CREATED', fulfillment.status, {
      detail: hold ?? `due ${fulfillment.dueAt.toISOString()}`,
    });
    if (hold) {
      this.logger.logWithMetadata(
        'warn',
        'Paid credit package order held for review',
        { context: LOG_CONTEXT, orderId: order.id, holdReason: hold },
      );
      if (order.giftId) await this.notifyUnderReview(tx, order.giftId);
    }
    return fulfillment;
  }

  /**
   * One attempt at one fulfillment (if due and not being processed by
   * another worker). Never throws for a failed grant: the failure is
   * recorded and retried later.
   */
  async processOne(
    id: string,
    now: Date = new Date(),
  ): Promise<FulfillmentOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "CreditFulfillment"
          WHERE "id" = ${id} AND "status" IN ('PENDING', 'RETRYING')
          FOR UPDATE SKIP LOCKED
        `;
        if (claimed.length === 0) return 'SKIPPED';
        const fulfillment = await this.load(tx, id);
        if (
          fulfillment.dueAt.getTime() > now.getTime() ||
          fulfillment.nextAttemptAt.getTime() > now.getTime()
        ) {
          return 'NOT_DUE';
        }
        const gift = fulfillment.order.gift
          ? await this.lockGift(tx, fulfillment.order.gift.id)
          : null;
        const hold = await this.holdReasonOf(tx, fulfillment);
        if (hold) {
          await this.hold(tx, fulfillment, gift, hold, now);
          return 'HELD';
        }
        await this.deliver(tx, fulfillment, gift, now, 'SUCCEEDED', null);
        return 'SUCCEEDED';
      }, FULFILLMENT_TRANSACTION_OPTIONS);
    } catch (error) {
      await this.recordFailure(id, error, now);
      return 'FAILED';
    }
  }

  /** Processes every due fulfillment; returns the outcomes. */
  async processDue(now: Date = new Date()): Promise<FulfillmentOutcome[]> {
    const due = await this.prisma.creditFulfillment.findMany({
      where: {
        status: {
          in: [
            CreditFulfillmentStatus.PENDING,
            CreditFulfillmentStatus.RETRYING,
          ],
        },
        nextAttemptAt: { lte: now },
        dueAt: { lte: now },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: DUE_BATCH,
      select: { id: true },
    });
    const outcomes: FulfillmentOutcome[] = [];
    for (const { id } of due) outcomes.push(await this.processOne(id, now));
    return outcomes;
  }

  // -------------------------------------------------------------------------
  // Administration
  // -------------------------------------------------------------------------

  async list(query: {
    status?: CreditFulfillmentStatus;
    kind?: CreditPackageOrderKind;
    limit?: number;
  }) {
    const rows = await this.prisma.creditFulfillment.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: query.limit ?? 50,
      include: {
        order: { include: { gift: true } },
        _count: { select: { events: true } },
      },
    });
    return rows.map((row) => this.toAdminView(row, row._count.events));
  }

  async get(id: string) {
    const row = await this.prisma.creditFulfillment.findUnique({
      where: { id },
      include: {
        order: { include: { gift: true } },
        events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!row) throw AppError.notFound('Fulfillment not found');
    return {
      ...this.toAdminView(row, row.events.length),
      events: row.events.map((event) => ({
        id: event.id,
        type: event.type,
        status: event.status,
        detail: event.detail,
        actor: event.actor,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  /** FAILED -> RETRYING now, then one attempt. */
  async retry(id: string, actor: ActivityLogMetadata & { actionedBy: string }) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const fulfillment = await this.lockForAdmin(tx, id);
      if (fulfillment.status !== CreditFulfillmentStatus.FAILED) {
        throw AppError.conflict('Only a failed fulfillment can be retried');
      }
      await tx.creditFulfillment.update({
        where: { id },
        data: { status: CreditFulfillmentStatus.RETRYING, nextAttemptAt: now },
      });
      await this.event(tx, id, 'RETRY_REQUESTED', 'RETRYING', {
        actor: actor.actionedBy,
      });
      await this.audit(tx, id, 'FAILED', 'RETRYING', actor);
    }, FULFILLMENT_TRANSACTION_OPTIONS);
    await this.processOne(id, now);
    return this.get(id);
  }

  /**
   * Delivers a HELD gift whose recipient was unverified or inactive (the
   * administrator decided); the recipient's account must still exist.
   */
  async approve(
    id: string,
    actor: ActivityLogMetadata & { actionedBy: string },
  ) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockForAdmin(tx, id);
      if (locked.status !== CreditFulfillmentStatus.HELD) {
        throw AppError.conflict('This fulfillment is not waiting for review');
      }
      if (!APPROVABLE.includes(locked.holdReason as FulfillmentHoldReason)) {
        throw AppError.conflict(
          'This fulfillment cannot be delivered; reject it (refund required)',
        );
      }
      const fulfillment = await this.load(tx, id);
      const recipient = fulfillment.recipientAuthId
        ? await tx.authUser.findUnique({
            where: { id: fulfillment.recipientAuthId },
            select: { status: true, deletedAt: true },
          })
        : null;
      if (
        !recipient ||
        recipient.deletedAt !== null ||
        recipient.status === 'DELETED' ||
        recipient.status === 'PENDING_DELETION'
      ) {
        throw AppError.conflict('The recipient can no longer receive credits');
      }
      const gift = fulfillment.order.gift
        ? await this.lockGift(tx, fulfillment.order.gift.id)
        : null;
      await this.deliver(
        tx,
        fulfillment,
        gift,
        now,
        'APPROVED',
        actor.actionedBy,
      );
      await this.audit(tx, id, 'HELD', 'SUCCEEDED', actor);
    }, FULFILLMENT_TRANSACTION_OPTIONS);
    return this.get(id);
  }

  /** A HELD or FAILED fulfillment is never granted (refund required). */
  async reject(
    id: string,
    actor: ActivityLogMetadata & { actionedBy: string },
  ) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockForAdmin(tx, id);
      if (
        locked.status !== CreditFulfillmentStatus.HELD &&
        locked.status !== CreditFulfillmentStatus.FAILED
      ) {
        throw AppError.conflict(
          'Only a held or failed fulfillment can be rejected',
        );
      }
      await tx.creditFulfillment.update({
        where: { id },
        data: { status: CreditFulfillmentStatus.REJECTED },
      });
      const fulfillment = await this.load(tx, id);
      const gift = fulfillment.order.gift;
      if (gift && gift.status === CreditGiftStatus.REVIEW) {
        await tx.creditGift.update({
          where: { id: gift.id },
          data: {
            status: CreditGiftStatus.REJECTED,
            reviewedAt: now,
            reviewedBy: actor.actionedBy,
          },
        });
      }
      if (gift?.senderAuthId) {
        await this.notifications.notify(
          tx,
          gift.senderAuthId,
          `gift-rejected:${fulfillment.orderId}`,
          notificationContent.giftRejected(gift.id, gift.credits),
        );
      }
      await this.event(tx, id, 'REJECTED', 'REJECTED', {
        actor: actor.actionedBy,
        detail: 'REFUND_REQUIRED',
      });
      await this.audit(tx, id, locked.status, 'REJECTED', actor);
    }, FULFILLMENT_TRANSACTION_OPTIONS);
    return this.get(id);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async deliver(
    tx: Prisma.TransactionClient,
    fulfillment: FulfillmentWithOrder,
    gift: CreditGift | null,
    now: Date,
    eventType: 'SUCCEEDED' | 'APPROVED',
    actor: string | null,
  ): Promise<void> {
    const recipientAuthId = fulfillment.recipientAuthId as string;
    await this.wallet.grant(
      {
        authId: recipientAuthId,
        source: fulfillment.source,
        sourceReference: fulfillment.creditReference,
        amount: String(fulfillment.credits),
        description:
          fulfillment.kind === CreditPackageOrderKind.GIFT
            ? `Gift: ${fulfillment.credits} credits`
            : `Credit package ${fulfillment.order.packageCode}: ${fulfillment.credits} credits`,
      },
      { tx, at: new Date() },
    );
    await tx.creditFulfillment.update({
      where: { id: fulfillment.id },
      data: {
        status: CreditFulfillmentStatus.SUCCEEDED,
        completedAt: now,
        attempts: { increment: 1 },
        lastAttemptAt: now,
        lastErrorCode: null,
      },
    });
    await this.event(tx, fulfillment.id, eventType, 'SUCCEEDED', { actor });
    if (fulfillment.kind === CreditPackageOrderKind.SELF) {
      // Credits were granted: the purchase confirmation, once.
      await this.notifications.notify(
        tx,
        recipientAuthId,
        `purchase-completed:${fulfillment.orderId}`,
        notificationContent.creditPurchaseCompleted(
          fulfillment.orderId,
          fulfillment.credits,
          formatUsdCents(fulfillment.order.amountUsdCents),
        ),
      );
    }
    if (gift) {
      await tx.creditGift.update({
        where: { id: gift.id },
        data: {
          status: CreditGiftStatus.DELIVERED,
          deliveredAt: now,
          ...(actor ? { reviewedAt: now, reviewedBy: actor } : {}),
        },
      });
      await this.notifyDelivered(tx, gift);
    }
  }

  private async hold(
    tx: Prisma.TransactionClient,
    fulfillment: FulfillmentWithOrder,
    gift: CreditGift | null,
    reason: FulfillmentHoldReason,
    now: Date,
  ): Promise<void> {
    await tx.creditFulfillment.update({
      where: { id: fulfillment.id },
      data: {
        status: CreditFulfillmentStatus.HELD,
        holdReason: reason,
        attempts: { increment: 1 },
        lastAttemptAt: now,
      },
    });
    await this.event(tx, fulfillment.id, 'HELD_FOR_REVIEW', 'HELD', {
      detail: reason,
    });
    if (gift && gift.status === CreditGiftStatus.PAID) {
      await tx.creditGift.update({
        where: { id: gift.id },
        data: { status: CreditGiftStatus.REVIEW, reviewReason: reason },
      });
      await this.notifyUnderReview(tx, gift.id);
    }
    this.logger.logWithMetadata('warn', 'Credit fulfillment held for review', {
      context: LOG_CONTEXT,
      fulfillmentId: fulfillment.id,
      holdReason: reason,
    });
  }

  /** A failed attempt: retried with backoff, FAILED after the last one. */
  private async recordFailure(id: string, error: unknown, now: Date) {
    const code = fulfillmentErrorCode(error);
    try {
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.creditFulfillment.findUnique({
          where: { id },
        });
        if (
          !current ||
          (current.status !== CreditFulfillmentStatus.PENDING &&
            current.status !== CreditFulfillmentStatus.RETRYING)
        ) {
          return;
        }
        const attempts = current.attempts + 1;
        const status =
          attempts >= MAX_FULFILLMENT_ATTEMPTS
            ? CreditFulfillmentStatus.FAILED
            : CreditFulfillmentStatus.RETRYING;
        const { count } = await tx.creditFulfillment.updateMany({
          where: { id, status: current.status, attempts: current.attempts },
          data: {
            status,
            attempts,
            lastAttemptAt: now,
            lastErrorCode: code,
            nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
          },
        });
        if (count === 1) {
          await this.event(tx, id, 'ATTEMPT_FAILED', status, { detail: code });
        }
      }, FULFILLMENT_TRANSACTION_OPTIONS);
    } catch {
      // The attempt stays due; the next run tries again.
    }
    this.logger.logWithMetadata('error', 'Credit fulfillment attempt failed', {
      context: LOG_CONTEXT,
      fulfillmentId: id,
      errorCode: code,
    });
  }

  private async holdReasonOf(
    tx: Prisma.TransactionClient,
    fulfillment: FulfillmentWithOrder,
  ): Promise<FulfillmentHoldReason | null> {
    if (!fulfillment.recipientAuthId) return 'RECIPIENT_DELETED';
    if (fulfillment.kind === CreditPackageOrderKind.SELF) return null;
    const recipient = await tx.authUser.findUnique({
      where: { id: fulfillment.recipientAuthId },
      select: { verified: true, status: true, deletedAt: true },
    });
    return recipientHoldReason(recipient);
  }

  private async notifyDelivered(
    tx: Prisma.TransactionClient,
    gift: CreditGift,
  ) {
    if (gift.recipientAuthId) {
      await this.notifications.notify(
        tx,
        gift.recipientAuthId,
        `gift-delivered:${gift.id}`,
        notificationContent.giftDelivered(gift.id, gift.credits),
      );
    }
    if (gift.senderAuthId && gift.recipientAuthId) {
      const recipient = await tx.authUser.findUnique({
        where: { id: gift.recipientAuthId },
        select: { username: true },
      });
      await this.notifications.notify(
        tx,
        gift.senderAuthId,
        `gift-delivered-sender:${gift.id}`,
        notificationContent.giftDeliveredToRecipient(
          gift.id,
          recipient?.username ?? 'The recipient',
          gift.credits,
        ),
      );
    }
  }

  /** The sender learns that their paid gift waits for a review. */
  private async notifyUnderReview(
    tx: Prisma.TransactionClient,
    giftId: string,
  ) {
    const gift = await tx.creditGift.findUniqueOrThrow({
      where: { id: giftId },
    });
    if (!gift.senderAuthId) return;
    await this.notifications.notify(
      tx,
      gift.senderAuthId,
      `gift-review:${gift.id}`,
      notificationContent.giftUnderReview(gift.id, gift.credits),
    );
  }

  private async usernameOf(
    tx: Prisma.TransactionClient,
    authId: string | null,
  ): Promise<string> {
    if (!authId) return 'the recipient';
    const user = await tx.authUser.findUnique({
      where: { id: authId },
      select: { username: true },
    });
    return user?.username ?? 'the recipient';
  }

  private load(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<FulfillmentWithOrder> {
    return tx.creditFulfillment.findUniqueOrThrow({
      where: { id },
      include: { order: { include: { gift: true } } },
    });
  }

  private async lockGift(
    tx: Prisma.TransactionClient,
    giftId: string,
  ): Promise<CreditGift> {
    await tx.$queryRaw`SELECT "id" FROM "CreditGift" WHERE "id" = ${giftId} FOR UPDATE`;
    return tx.creditGift.findUniqueOrThrow({ where: { id: giftId } });
  }

  private async lockForAdmin(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<CreditFulfillment> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "CreditFulfillment" WHERE "id" = ${id} FOR UPDATE
    `;
    if (locked.length === 0) throw AppError.notFound('Fulfillment not found');
    return tx.creditFulfillment.findUniqueOrThrow({ where: { id } });
  }

  private async event(
    tx: Prisma.TransactionClient,
    fulfillmentId: string,
    type: string,
    status: CreditFulfillmentStatus,
    extra: { detail?: string | null; actor?: string | null } = {},
  ) {
    await tx.creditFulfillmentEvent.create({
      data: {
        fulfillmentId,
        type,
        status,
        detail: extra.detail?.slice(0, 200) ?? null,
        actor: extra.actor ?? null,
      },
    });
  }

  private audit(
    tx: Prisma.TransactionClient,
    id: string,
    from: string,
    to: string,
    actor: ActivityLogMetadata & { actionedBy: string },
  ) {
    return this.activityLog.logActivity(
      {
        tableName: 'CreditFulfillment',
        recordId: id,
        action: 'update',
        changes: [{ fieldName: 'status', oldValue: from, newValue: to }],
        metadata: actor,
      },
      tx,
    );
  }

  private toAdminView(
    row: FulfillmentWithOrder & CreditFulfillment,
    eventCount: number,
  ) {
    const gift = row.order.gift;
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      credits: row.credits,
      source: row.source,
      recipientAuthId: row.recipientAuthId,
      dueAt: row.dueAt.toISOString(),
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      holdReason: row.holdReason,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      order: {
        id: row.order.id,
        status: row.order.status,
        payerAuthId: row.order.authId,
        packageCode: row.order.packageCode,
        amountUsdCents: row.order.amountUsdCents,
        paidAt: row.order.paidAt?.toISOString() ?? null,
      },
      gift: gift
        ? {
            id: gift.id,
            status: gift.status,
            senderAuthId: gift.senderAuthId,
            recipientAuthId: gift.recipientAuthId,
            deliverAt: gift.deliverAt.toISOString(),
            reviewReason: gift.reviewReason,
          }
        : null,
      events: eventCount,
    };
  }
}
