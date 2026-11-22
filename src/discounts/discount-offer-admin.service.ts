import { Injectable } from '@nestjs/common';
import {
  DiscountAudience,
  DiscountOfferKind,
  Prisma,
  type DiscountOffer,
} from '@prisma/client';
import AppError from '../common/errors/app.error';
import {
  ActivityLogService,
  type FieldChange,
} from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import { DISCOUNT_MESSAGES } from './discount-offer.constants';
import {
  discountOfferStatus,
  normalizeDiscountCode,
  remainingRedemptions,
} from './discount-offer.policy';
import type {
  CreateDiscountOfferInput,
  DiscountOfferChangeActor,
  DiscountOfferInput,
  DiscountOfferView,
} from './interfaces/discount-offer.interface';

type OfferWithTargets = DiscountOffer & { targets: { authId: string }[] };

const CHANGE_FIELDS: readonly (keyof DiscountOfferInput)[] = [
  'name',
  'discountPercent',
  'active',
  'startsAt',
  'endsAt',
  'maxRedemptionsPerUser',
  'maxTotalRedemptions',
  'targetUserIds',
];

/** Audited fields, as strings (null when unset). */
type AuditRecord = Record<string, string | null>;

const NOUN: Record<DiscountOfferKind, string> = {
  CODE: 'Discount code',
  CAMPAIGN: 'Discount campaign',
};

/**
 * Administration of discount codes and campaigns (both are DiscountOffer
 * rows; `kind` keeps them apart, so a code is never found through the
 * campaign routes or vice versa). Offers are deactivated, never deleted, so
 * their redemptions stay attached. Every change is audited in the same
 * transaction, and changes lock the offer row, so they are applied one at a
 * time and consistently with concurrent redemptions.
 */
@Injectable()
export class DiscountOfferAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async create(
    kind: DiscountOfferKind,
    input: CreateDiscountOfferInput,
    actor: DiscountOfferChangeActor,
  ): Promise<DiscountOfferView> {
    const now = new Date();
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    this.assertPeriod(startsAt, endsAt);
    if (endsAt.getTime() <= now.getTime()) {
      throw AppError.badRequest('endsAt must be in the future');
    }
    const code =
      kind === DiscountOfferKind.CODE && input.code
        ? normalizeDiscountCode(input.code)
        : null;
    const targets = input.targetUserIds ?? null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (targets) await this.assertUsersExist(tx, targets);
        const created = await tx.discountOffer.create({
          data: {
            kind,
            code,
            name: (input.name ?? code ?? '').trim(),
            discountPercent: input.discountPercent,
            active: input.active ?? true,
            startsAt,
            endsAt,
            audience: targets
              ? DiscountAudience.SELECTED_USERS
              : DiscountAudience.ALL_USERS,
            maxRedemptionsPerUser: input.maxRedemptionsPerUser ?? 1,
            maxTotalRedemptions: input.maxTotalRedemptions ?? null,
            targets: targets
              ? { create: targets.map((authId) => ({ authId })) }
              : undefined,
          },
          include: { targets: { select: { authId: true } } },
        });
        await this.activityLog.logActivity(
          {
            tableName: 'DiscountOffer',
            recordId: created.id,
            action: 'create',
            changes: [
              ...this.diff(null, this.auditRecord(created)),
              ...[this.targetChange(null, created)].filter(
                (change): change is FieldChange => change !== null,
              ),
            ],
            metadata: actor,
          },
          tx,
        );
        return this.toView(created, now);
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Newest first. */
  async list(kind: DiscountOfferKind): Promise<DiscountOfferView[]> {
    const now = new Date();
    const offers = await this.prisma.discountOffer.findMany({
      where: { kind },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: { targets: { select: { authId: true } } },
    });
    return offers.map((offer) => this.toView(offer, now));
  }

  async get(kind: DiscountOfferKind, id: string): Promise<DiscountOfferView> {
    const offer = await this.prisma.discountOffer.findFirst({
      where: { id, kind },
      include: { targets: { select: { authId: true } } },
    });
    if (!offer) throw AppError.notFound(`${NOUN[kind]} not found`);
    return this.toView(offer, new Date());
  }

  /**
   * Applies a partial change. The total limit can never go below the
   * redemptions already made; `targetUserIds` replaces the whole list.
   */
  async update(
    kind: DiscountOfferKind,
    id: string,
    input: DiscountOfferInput,
    actor: DiscountOfferChangeActor,
  ): Promise<DiscountOfferView> {
    if (!CHANGE_FIELDS.some((field) => input[field] !== undefined)) {
      throw AppError.badRequest(
        `Provide at least one of ${CHANGE_FIELDS.join(', ')}`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, kind, id);
      const now = new Date();
      const startsAt =
        input.startsAt !== undefined
          ? new Date(input.startsAt)
          : before.startsAt;
      const endsAt =
        input.endsAt !== undefined ? new Date(input.endsAt) : before.endsAt;
      this.assertPeriod(startsAt, endsAt);
      if (
        typeof input.maxTotalRedemptions === 'number' &&
        input.maxTotalRedemptions < before.redemptionCount
      ) {
        throw AppError.conflict(
          `maxTotalRedemptions cannot be lower than the ${before.redemptionCount} redemption(s) already made`,
        );
      }

      const data: Prisma.DiscountOfferUpdateInput = {
        name: input.name?.trim(),
        discountPercent: input.discountPercent,
        active: input.active,
        startsAt: input.startsAt !== undefined ? startsAt : undefined,
        endsAt: input.endsAt !== undefined ? endsAt : undefined,
        maxRedemptionsPerUser: input.maxRedemptionsPerUser,
        maxTotalRedemptions: input.maxTotalRedemptions,
      };
      if (input.targetUserIds !== undefined) {
        const targets = input.targetUserIds;
        if (targets) await this.assertUsersExist(tx, targets);
        await tx.discountOfferTarget.deleteMany({ where: { offerId: id } });
        if (targets) {
          await tx.discountOfferTarget.createMany({
            data: targets.map((authId) => ({ offerId: id, authId })),
          });
        }
        data.audience = targets
          ? DiscountAudience.SELECTED_USERS
          : DiscountAudience.ALL_USERS;
      }

      const after = await tx.discountOffer.update({
        where: { id },
        data,
        include: { targets: { select: { authId: true } } },
      });
      await this.audit(tx, before, after, actor);
      return this.toView(after, now);
    });
  }

  /** Switches the offer off (idempotent). Redemptions stay recorded. */
  async deactivate(
    kind: DiscountOfferKind,
    id: string,
    actor: DiscountOfferChangeActor,
  ): Promise<DiscountOfferView> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, kind, id);
      const after = await tx.discountOffer.update({
        where: { id },
        data: { active: false },
        include: { targets: { select: { authId: true } } },
      });
      await this.audit(tx, before, after, actor);
      return this.toView(after, new Date());
    });
  }

  /** Locks the offer row (404 for an unknown ID or the other kind). */
  private async lock(
    tx: Prisma.TransactionClient,
    kind: DiscountOfferKind,
    id: string,
  ): Promise<OfferWithTargets> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "DiscountOffer"
      WHERE "id" = ${id} AND "kind" = ${kind}::"DiscountOfferKind"
      FOR UPDATE
    `;
    if (locked.length === 0) throw AppError.notFound(`${NOUN[kind]} not found`);
    return tx.discountOffer.findUniqueOrThrow({
      where: { id },
      include: { targets: { select: { authId: true } } },
    });
  }

  private assertPeriod(startsAt: Date, endsAt: Date): void {
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw AppError.badRequest('endsAt must be after startsAt');
    }
  }

  private async assertUsersExist(
    tx: Prisma.TransactionClient,
    ids: string[],
  ): Promise<void> {
    const found = await tx.authUser.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const known = new Set(found.map((user) => user.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw AppError.badRequest(
        `Unknown user ID(s) in targetUserIds: ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? ', ...' : ''}`,
      );
    }
  }

  private async audit(
    tx: Prisma.TransactionClient,
    before: OfferWithTargets,
    after: OfferWithTargets,
    actor: DiscountOfferChangeActor,
  ): Promise<void> {
    const changes = this.diff(
      this.auditRecord(before),
      this.auditRecord(after),
    );
    const targetChange = this.targetChange(before, after);
    if (targetChange) changes.push(targetChange);
    if (changes.length === 0) return;
    await this.activityLog.logActivity(
      {
        tableName: 'DiscountOffer',
        recordId: after.id,
        action: 'update',
        changes,
        metadata: actor,
      },
      tx,
    );
  }

  /** The audited fields (targeted users are audited separately). */
  private auditRecord(offer: OfferWithTargets): AuditRecord {
    return {
      kind: offer.kind,
      code: offer.code,
      name: offer.name,
      discountPercent: String(offer.discountPercent),
      active: String(offer.active),
      startsAt: offer.startsAt.toISOString(),
      endsAt: offer.endsAt.toISOString(),
      audience: offer.audience,
      maxRedemptionsPerUser: String(offer.maxRedemptionsPerUser),
      maxTotalRedemptions:
        offer.maxTotalRedemptions === null
          ? null
          : String(offer.maxTotalRedemptions),
    };
  }

  /**
   * Records that the set of targeted users changed, as user counts: the IDs
   * of other people do not belong in the administrators' activity log.
   */
  private targetChange(
    before: OfferWithTargets | null,
    after: OfferWithTargets,
  ): FieldChange | null {
    const old = new Set(before?.targets.map((t) => t.authId) ?? []);
    const next = after.targets.map((t) => t.authId);
    if (old.size === next.length && next.every((id) => old.has(id))) {
      return null;
    }
    return {
      fieldName: 'targetUserIds',
      oldValue: before ? `${old.size} user(s)` : null,
      newValue: `${next.length} user(s)`,
    };
  }

  private diff(before: AuditRecord | null, after: AuditRecord): FieldChange[] {
    return Object.keys(after)
      .filter((field) => (before ? before[field] : null) !== after[field])
      .map((field) => ({
        fieldName: field,
        oldValue: before ? before[field] : null,
        newValue: after[field],
      }));
  }

  private translate(error: unknown): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return AppError.conflict(DISCOUNT_MESSAGES.CODE_TAKEN);
    }
    return error;
  }

  toView(offer: OfferWithTargets, now: Date): DiscountOfferView {
    return {
      id: offer.id,
      kind: offer.kind,
      ...(offer.code !== null ? { code: offer.code } : {}),
      name: offer.name,
      discountPercent: offer.discountPercent,
      active: offer.active,
      status: discountOfferStatus(offer, now),
      startsAt: offer.startsAt.toISOString(),
      endsAt: offer.endsAt.toISOString(),
      audience: offer.audience,
      targetUserIds: offer.targets.map((t) => t.authId).sort(),
      maxRedemptionsPerUser: offer.maxRedemptionsPerUser,
      maxTotalRedemptions: offer.maxTotalRedemptions,
      redemptionCount: offer.redemptionCount,
      remainingRedemptions: remainingRedemptions(offer),
      createdAt: offer.createdAt.toISOString(),
      updatedAt: offer.updatedAt.toISOString(),
    };
  }
}
