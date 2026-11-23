import type { NotificationType } from '@prisma/client';

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPageView {
  items: NotificationView[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  unreadCount: number;
}

export interface NotificationPreferencesView {
  email: {
    referralRewards: boolean;
    referralMilestones: boolean;
    gifts: boolean;
    purchases: boolean;
    /** Always true: security emails cannot be turned off. */
    security: true;
  };
  updatedAt: string | null;
}
