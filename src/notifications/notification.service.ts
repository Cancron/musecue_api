import { Injectable } from '@nestjs/common';
import {
  type Notification,
  NotificationEmailStatus,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import AppError from '../common/errors/app.error';
import { PrismaService } from '../common/services/prisma.service';
import type {
  NotificationPageView,
  NotificationPreferencesView,
  NotificationView,
} from './interfaces/notification.interface';
import {
  DEFAULT_EMAIL_PREFERENCES,
  decodeCursor,
  encodeCursor,
  type NotificationContent,
  wantsEmail,
} from './notification.policy';

const DEFAULT_PAGE_SIZE = 20;

/**
 * Notifications: creation and the owner's inbox.
 *
 * A notification is created by the code that handles its event, inside that
 * event's transaction (an outbox), with an `eventKey` unique per user: a
 * retried, concurrent or replayed event, or work redone after a restart,
 * finds the existing entry and creates nothing. Whether it is emailed is
 * decided at creation from the user's preferences (security notifications
 * always); NotificationOutboxService hands PENDING emails to the existing
 * email queue. Every inbox query is scoped to the owner.
 */
@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates the notification of one event unless it already exists. Returns
   * its id when it was created now, null when it already existed.
   */
  async notify(
    client: Prisma.TransactionClient,
    authId: string,
    eventKey: string,
    content: NotificationContent,
  ): Promise<string | null> {
    const stored = await client.notificationPreference.findUnique({
      where: { authId },
    });
    const preferences = stored ?? DEFAULT_EMAIL_PREFERENCES;
    const id = randomUUID();
    const { count } = await client.notification.createMany({
      data: [
        {
          id,
          authId,
          type: content.type,
          eventKey,
          title: content.title,
          body: content.body,
          data: content.data ?? Prisma.JsonNull,
          emailStatus: wantsEmail(content.type, preferences)
            ? NotificationEmailStatus.PENDING
            : NotificationEmailStatus.NOT_REQUESTED,
        },
      ],
      skipDuplicates: true,
    });
    return count === 1 ? id : null;
  }

  async list(
    authId: string,
    options: {
      limit?: number;
      cursor?: string;
      status?: 'all' | 'unread' | 'read';
    },
  ): Promise<NotificationPageView> {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    const after = options.cursor ? decodeCursor(options.cursor) : null;
    if (options.cursor && !after) throw AppError.badRequest('Invalid cursor');
    const where: Prisma.NotificationWhereInput = {
      authId,
      ...(options.status === 'unread'
        ? { readAt: null }
        : options.status === 'read'
          ? { readAt: { not: null } }
          : {}),
      ...(after
        ? {
            OR: [
              { createdAt: { lt: after.createdAt } },
              { createdAt: after.createdAt, id: { lt: after.id } },
            ],
          }
        : {}),
    };
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.unreadCount(authId),
    ]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => this.toView(row)),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.createdAt, last.id)
          : null,
      unreadCount,
    };
  }

  unreadCount(authId: string): Promise<number> {
    return this.prisma.notification.count({ where: { authId, readAt: null } });
  }

  /** Marks one of the owner's notifications read or unread (404 otherwise). */
  async setRead(
    authId: string,
    id: string,
    read: boolean,
  ): Promise<NotificationView> {
    const existing = await this.prisma.notification.findFirst({
      where: { id, authId },
    });
    if (!existing) throw AppError.notFound('Notification not found');
    // Marking read keeps the first read time.
    if (read === (existing.readAt !== null)) return this.toView(existing);
    const updated = await this.prisma.notification.update({
      where: { id: existing.id },
      data: { readAt: read ? new Date() : null },
    });
    return this.toView(updated);
  }

  async markAllRead(authId: string): Promise<{ updated: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { authId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }

  async getPreferences(authId: string): Promise<NotificationPreferencesView> {
    const stored = await this.prisma.notificationPreference.findUnique({
      where: { authId },
    });
    return this.toPreferencesView(stored);
  }

  async updatePreferences(
    authId: string,
    input: { referralRewards?: boolean; referralMilestones?: boolean },
  ): Promise<NotificationPreferencesView> {
    const data = {
      ...(input.referralRewards !== undefined
        ? { emailReferralRewards: input.referralRewards }
        : {}),
      ...(input.referralMilestones !== undefined
        ? { emailReferralMilestones: input.referralMilestones }
        : {}),
    };
    const stored = await this.prisma.notificationPreference.upsert({
      where: { authId },
      create: { authId, ...DEFAULT_EMAIL_PREFERENCES, ...data },
      update: data,
    });
    return this.toPreferencesView(stored);
  }

  private toPreferencesView(
    stored: {
      emailReferralRewards: boolean;
      emailReferralMilestones: boolean;
      updatedAt: Date;
    } | null,
  ): NotificationPreferencesView {
    const preferences = stored ?? DEFAULT_EMAIL_PREFERENCES;
    return {
      email: {
        referralRewards: preferences.emailReferralRewards,
        referralMilestones: preferences.emailReferralMilestones,
        security: true,
      },
      updatedAt: stored?.updatedAt.toISOString() ?? null,
    };
  }

  private toView(row: Notification): NotificationView {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      data:
        row.data && typeof row.data === 'object' && !Array.isArray(row.data)
          ? (row.data as Record<string, unknown>)
          : null,
      read: row.readAt !== null,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
