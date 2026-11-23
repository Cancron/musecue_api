import { Injectable } from '@nestjs/common';
import {
  CreditGiftStatus,
  CreditPackageOrderStatus,
  Prisma,
  type CreditGift,
  type CreditPackageOrder,
} from '@prisma/client';
import AppError from '../../common/errors/app.error';
import { PrismaService } from '../../common/services/prisma.service';
import { notificationContent } from '../../notifications/notification.policy';
import { NotificationService } from '../../notifications/notification.service';
import {
  isPurchaseAccountEligible,
  TRIAL_ACCOUNT_SELECT,
} from '../../subscription/subscription-access.policy';
import type { CreditPackageOrderView } from '../purchases/credit-package-order.interface';
import { CreditPackageCheckoutService } from '../purchases/credit-package-checkout.service';
import type { CreditGiftView } from './credit-gift.interface';

/** Payment and credit work can wait for row locks under load. */
const GIFT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

export const GIFT_INVITATION_DAYS = 7;
const MAX_DELIVERY_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_MAX = 200;

export const GIFT_MESSAGES = {
  NOT_FOUND: 'Gift not found',
  RECIPIENT_NOT_FOUND: 'Recipient not found',
  SELF_GIFT: 'You cannot send a gift to yourself',
  PACKAGE_UNAVAILABLE: 'This credit package is not available',
  ACCOUNT_INACTIVE: 'Only active, verified accounts can send gifts',
  INVALID_DELIVERY:
    'deliverAt must be in the future and at most 365 days ahead',
  NOT_PENDING: 'This gift invitation is no longer waiting for an answer',
  NOT_CANCELABLE: 'This gift can no longer be canceled',
  EXPIRED: 'This gift invitation has expired',
  PAYMENT_IN_PROGRESS:
    'The payment of this gift was already made or is being processed',
  IDEMPOTENCY_KEY_REQUIRED:
    'An Idempotency-Key header (1-200 characters) is required',
  IDEMPOTENCY_KEY_REUSED:
    'This Idempotency-Key was already used for another gift',
} as const;

const OPEN_ORDER: CreditPackageOrderStatus[] = [
  CreditPackageOrderStatus.CREATING,
  CreditPackageOrderStatus.OPEN,
  CreditPackageOrderStatus.PROCESSING,
];

type GiftRow = CreditGift & {
  sender: { id: string; username: string } | null;
  recipient: { id: string; username: string } | null;
  orders: CreditPackageOrder[];
};

/**
 * Credit package gifts between users.
 *
 * 1. The sender invites a recipient (an existing account, by email or
 *    username) with a package; its credits and price are locked (checked
 *    by PostgreSQL against the package configuration) and the recipient is
 *    notified. Nothing is charged.
 * 2. The recipient accepts or declines it. Declined, expired (not accepted
 *    and paid within GIFT_INVITATION_DAYS) and canceled gifts can never be
 *    paid.
 * 3. The sender pays an accepted gift through a Stripe checkout
 *    (CreditPackageCheckoutService: discounts are the sender's). The
 *    verified payment makes the gift PAID; the credits are delivered once to
 *    the recipient at `deliverAt` (CreditFulfillmentService), or held for an
 *    administrator if the recipient cannot receive credits then.
 *
 * Receiving a gift never changes the recipient's first-purchase or referral
 * eligibility (it is the sender's purchase). Users only ever see gifts they
 * sent or received (404 otherwise).
 */
@Injectable()
export class CreditGiftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkout: CreditPackageCheckoutService,
    private readonly notifications: NotificationService,
  ) {}

  async send(
    senderAuthId: string,
    input: {
      packageCode: CreditGift['packageCode'];
      recipient: string;
      message?: string;
      deliverAt?: string;
    },
    rawKey: string | undefined,
    now: Date = new Date(),
  ): Promise<CreditGiftView> {
    const idempotencyKey = this.requireKey(rawKey);
    const identifier = input.recipient.trim();
    const recipient = await this.prisma.authUser.findFirst({
      where: {
        OR: [
          { email: { equals: identifier, mode: 'insensitive' } },
          { username: identifier },
        ],
        deletedAt: null,
      },
      select: { id: true, username: true },
    });
    if (!recipient) throw AppError.notFound(GIFT_MESSAGES.RECIPIENT_NOT_FOUND);
    const previous = await this.prisma.creditGift.findUnique({
      where: {
        senderAuthId_idempotencyKey: { senderAuthId, idempotencyKey },
      },
      include: GIFT_INCLUDE,
    });
    if (previous) {
      return this.replay(previous, senderAuthId, input, recipient.id);
    }

    const sender = await this.prisma.authUser.findUnique({
      where: { id: senderAuthId },
      select: { ...TRIAL_ACCOUNT_SELECT, username: true },
    });
    if (!sender || !isPurchaseAccountEligible(sender)) {
      throw AppError.forbidden(GIFT_MESSAGES.ACCOUNT_INACTIVE);
    }
    if (recipient.id === senderAuthId) {
      throw AppError.badRequest(GIFT_MESSAGES.SELF_GIFT);
    }
    const deliverAt = input.deliverAt ? new Date(input.deliverAt) : now;
    if (
      Number.isNaN(deliverAt.getTime()) ||
      (input.deliverAt !== undefined && deliverAt.getTime() <= now.getTime()) ||
      deliverAt.getTime() > now.getTime() + MAX_DELIVERY_DAYS * DAY_MS
    ) {
      throw AppError.badRequest(GIFT_MESSAGES.INVALID_DELIVERY);
    }

    try {
      const gift = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "code" FROM "CreditPackage"
          WHERE "code" = ${input.packageCode}::"CreditPackageCode" FOR SHARE
        `;
        const pkg = await tx.creditPackage.findUnique({
          where: { code: input.packageCode },
        });
        if (!pkg?.available) {
          throw AppError.conflict(GIFT_MESSAGES.PACKAGE_UNAVAILABLE);
        }
        const created = await tx.creditGift.create({
          data: {
            senderAuthId,
            recipientAuthId: recipient.id,
            idempotencyKey,
            packageCode: pkg.code,
            credits: pkg.credits,
            listPriceUsdCents: pkg.priceUsdCents,
            message: input.message?.trim() || null,
            deliverAt,
            expiresAt: new Date(now.getTime() + GIFT_INVITATION_DAYS * DAY_MS),
          },
          include: GIFT_INCLUDE,
        });
        await this.notifications.notify(
          tx,
          recipient.id,
          `gift-invitation:${created.id}`,
          notificationContent.giftReceived(
            created.id,
            sender.username,
            created.credits,
          ),
        );
        return created;
      }, GIFT_TRANSACTION_OPTIONS);
      return this.toView(gift, senderAuthId, false);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.creditGift.findUnique({
          where: {
            senderAuthId_idempotencyKey: { senderAuthId, idempotencyKey },
          },
          include: GIFT_INCLUDE,
        });
        if (winner) {
          return this.replay(winner, senderAuthId, input, recipient.id);
        }
      }
      throw error;
    }
  }

  async list(
    authId: string,
    query: { box?: 'sent' | 'received'; limit?: number },
    now: Date = new Date(),
  ): Promise<CreditGiftView[]> {
    const gifts = await this.prisma.creditGift.findMany({
      where:
        query.box === 'received'
          ? { recipientAuthId: authId }
          : { senderAuthId: authId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit ?? 50,
      include: GIFT_INCLUDE,
    });
    return gifts.map((gift) => this.toView(gift, authId, undefined, now));
  }

  async get(authId: string, giftId: string, now: Date = new Date()) {
    return this.toView(
      await this.findOwn(authId, giftId),
      authId,
      undefined,
      now,
    );
  }

  /** The recipient accepts a pending invitation. */
  async accept(authId: string, giftId: string, now: Date = new Date()) {
    const gift = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockOwn(tx, giftId, { recipient: authId });
      this.assertAnswerable(current, now);
      const accepted = await tx.creditGift.update({
        where: { id: giftId },
        data: { status: CreditGiftStatus.ACCEPTED, acceptedAt: now },
        include: GIFT_INCLUDE,
      });
      if (accepted.senderAuthId) {
        await this.notifications.notify(
          tx,
          accepted.senderAuthId,
          `gift-accepted:${giftId}`,
          notificationContent.giftAccepted(
            giftId,
            accepted.recipient?.username ?? 'The recipient',
            accepted.credits,
          ),
        );
      }
      return accepted;
    }, GIFT_TRANSACTION_OPTIONS);
    return this.toView(gift, authId, undefined, now);
  }

  /**
   * The recipient declines a pending or accepted (not yet paid) gift. An
   * open checkout of it is closed first (Stripe confirms).
   */
  async decline(authId: string, giftId: string, now: Date = new Date()) {
    const own = await this.findOwn(authId, giftId, 'recipient');
    await this.closeOpenCheckout(own, now);
    const gift = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockOwn(tx, giftId, { recipient: authId });
      if (
        current.status !== CreditGiftStatus.PENDING &&
        current.status !== CreditGiftStatus.ACCEPTED
      ) {
        throw AppError.conflict(GIFT_MESSAGES.NOT_PENDING);
      }
      await this.assertNoPaymentInProgress(tx, giftId);
      const declined = await tx.creditGift.update({
        where: { id: giftId },
        data: { status: CreditGiftStatus.DECLINED, declinedAt: now },
        include: GIFT_INCLUDE,
      });
      if (declined.senderAuthId) {
        await this.notifications.notify(
          tx,
          declined.senderAuthId,
          `gift-declined:${giftId}`,
          notificationContent.giftDeclined(
            giftId,
            declined.recipient?.username ?? 'The recipient',
            declined.credits,
          ),
        );
      }
      return declined;
    }, GIFT_TRANSACTION_OPTIONS);
    return this.toView(gift, authId, undefined, now);
  }

  /** The sender cancels a gift that was not paid. */
  async cancel(authId: string, giftId: string, now: Date = new Date()) {
    const own = await this.findOwn(authId, giftId, 'sender');
    await this.closeOpenCheckout(own, now);
    const gift = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockOwn(tx, giftId, { sender: authId });
      if (
        current.status !== CreditGiftStatus.PENDING &&
        current.status !== CreditGiftStatus.ACCEPTED
      ) {
        throw AppError.conflict(GIFT_MESSAGES.NOT_CANCELABLE);
      }
      await this.assertNoPaymentInProgress(tx, giftId);
      return tx.creditGift.update({
        where: { id: giftId },
        data: { status: CreditGiftStatus.CANCELED, canceledAt: now },
        include: GIFT_INCLUDE,
      });
    }, GIFT_TRANSACTION_OPTIONS);
    return this.toView(gift, authId, undefined, now);
  }

  /** The sender pays an accepted gift (a Stripe checkout). */
  async pay(
    authId: string,
    giftId: string,
    options: { discountCode?: string | null },
    rawKey: string | undefined,
    now: Date = new Date(),
  ): Promise<CreditPackageOrderView> {
    const gift = await this.findOwn(authId, giftId, 'sender');
    if (gift.status === CreditGiftStatus.PENDING) {
      throw AppError.conflict('The recipient has not accepted this gift yet');
    }
    if (gift.status !== CreditGiftStatus.ACCEPTED) {
      throw AppError.conflict(
        `This gift cannot be paid (${gift.status.toLowerCase()})`,
      );
    }
    if (gift.expiresAt.getTime() <= now.getTime()) {
      throw AppError.conflict(GIFT_MESSAGES.EXPIRED);
    }
    return this.checkout.createGiftOrder(authId, gift, options, rawKey, now);
  }

  /**
   * Marks invitations that were not accepted and paid in time EXPIRED (no
   * checkout in progress). Returns how many.
   */
  async expireDue(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.creditGift.updateMany({
      where: {
        status: { in: [CreditGiftStatus.PENDING, CreditGiftStatus.ACCEPTED] },
        expiresAt: { lte: now },
        orders: { none: { status: { in: [...OPEN_ORDER, 'PAID'] } } },
      },
      data: { status: CreditGiftStatus.EXPIRED, expiredAt: now },
    });
    return count;
  }

  // -------------------------------------------------------------------------

  private assertAnswerable(gift: CreditGift, now: Date) {
    if (gift.status !== CreditGiftStatus.PENDING) {
      throw AppError.conflict(GIFT_MESSAGES.NOT_PENDING);
    }
    if (gift.expiresAt.getTime() <= now.getTime()) {
      throw AppError.conflict(GIFT_MESSAGES.EXPIRED);
    }
  }

  private async assertNoPaymentInProgress(
    tx: Prisma.TransactionClient,
    giftId: string,
  ) {
    const busy = await tx.creditPackageOrder.count({
      where: {
        giftId,
        status: {
          in: [
            CreditPackageOrderStatus.PROCESSING,
            CreditPackageOrderStatus.PAID,
          ],
        },
      },
    });
    if (busy > 0) throw AppError.conflict(GIFT_MESSAGES.PAYMENT_IN_PROGRESS);
  }

  /** Closes the gift's open Stripe checkout (Stripe confirms first). */
  private async closeOpenCheckout(gift: GiftRow, now: Date) {
    const open = gift.orders.find(
      (order) =>
        order.status === CreditPackageOrderStatus.OPEN ||
        order.status === CreditPackageOrderStatus.CREATING,
    );
    if (open?.authId) {
      await this.checkout.cancelOrder(open.authId, open.id, now);
    }
  }

  private async findOwn(
    authId: string,
    giftId: string,
    role?: 'sender' | 'recipient',
  ): Promise<GiftRow> {
    const gift = await this.prisma.creditGift.findUnique({
      where: { id: giftId },
      include: GIFT_INCLUDE,
    });
    const isSender = gift?.senderAuthId === authId;
    const isRecipient = gift?.recipientAuthId === authId;
    if (
      !gift ||
      (role === 'sender' && !isSender) ||
      (role === 'recipient' && !isRecipient) ||
      (!role && !isSender && !isRecipient)
    ) {
      throw AppError.notFound(GIFT_MESSAGES.NOT_FOUND);
    }
    return gift;
  }

  private async lockOwn(
    tx: Prisma.TransactionClient,
    giftId: string,
    owner: { sender?: string; recipient?: string },
  ): Promise<CreditGift> {
    await tx.$queryRaw`SELECT "id" FROM "CreditGift" WHERE "id" = ${giftId} FOR UPDATE`;
    const gift = await tx.creditGift.findUnique({ where: { id: giftId } });
    if (
      !gift ||
      (owner.sender && gift.senderAuthId !== owner.sender) ||
      (owner.recipient && gift.recipientAuthId !== owner.recipient)
    ) {
      throw AppError.notFound(GIFT_MESSAGES.NOT_FOUND);
    }
    return gift;
  }

  private replay(
    gift: GiftRow,
    senderAuthId: string,
    input: { packageCode: string },
    recipientAuthId: string,
  ): CreditGiftView {
    if (
      gift.packageCode !== input.packageCode ||
      gift.recipientAuthId !== recipientAuthId
    ) {
      throw AppError.conflict(GIFT_MESSAGES.IDEMPOTENCY_KEY_REUSED);
    }
    return this.toView(gift, senderAuthId, true);
  }

  private requireKey(raw: string | undefined): string {
    const key = raw?.trim();
    if (!key || key.length > IDEMPOTENCY_KEY_MAX) {
      throw AppError.badRequest(GIFT_MESSAGES.IDEMPOTENCY_KEY_REQUIRED);
    }
    return key;
  }

  private toView(
    gift: GiftRow,
    authId: string,
    replayed?: boolean,
    now: Date = new Date(),
  ): CreditGiftView {
    const role = gift.senderAuthId === authId ? 'sender' : 'recipient';
    // An invitation past its expiry is shown expired before the sweep.
    const lapsed =
      (gift.status === CreditGiftStatus.PENDING ||
        gift.status === CreditGiftStatus.ACCEPTED) &&
      gift.expiresAt.getTime() <= now.getTime() &&
      !gift.orders.some((order) => OPEN_ORDER.includes(order.status));
    const current = gift.orders.find((order) =>
      [...OPEN_ORDER, CreditPackageOrderStatus.PAID].includes(order.status),
    );
    return {
      id: gift.id,
      role,
      status: lapsed ? CreditGiftStatus.EXPIRED : gift.status,
      sender: gift.sender,
      recipient: gift.recipient,
      packageCode: gift.packageCode,
      credits: gift.credits,
      message: gift.message,
      deliverAt: gift.deliverAt.toISOString(),
      expiresAt: gift.expiresAt.toISOString(),
      acceptedAt: gift.acceptedAt?.toISOString() ?? null,
      declinedAt: gift.declinedAt?.toISOString() ?? null,
      canceledAt: gift.canceledAt?.toISOString() ?? null,
      paidAt: gift.paidAt?.toISOString() ?? null,
      deliveredAt: gift.deliveredAt?.toISOString() ?? null,
      createdAt: gift.createdAt.toISOString(),
      ...(role === 'sender'
        ? {
            listPriceUsdCents: gift.listPriceUsdCents,
            checkout: current
              ? {
                  orderId: current.id,
                  status: current.status,
                  amountDueUsdCents: current.amountUsdCents,
                  checkoutUrl:
                    current.status === CreditPackageOrderStatus.OPEN
                      ? current.url
                      : null,
                }
              : null,
          }
        : {}),
      ...(replayed !== undefined ? { replayed } : {}),
    };
  }
}

const GIFT_INCLUDE = {
  sender: { select: { id: true, username: true } },
  recipient: { select: { id: true, username: true } },
  orders: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.CreditGiftInclude;
