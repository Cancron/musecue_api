import { Injectable } from '@nestjs/common';
import {
  LoyaltyMissionRecurrence,
  type LoyaltyMission,
  type LoyaltyMissionAward,
} from '@prisma/client';
import AppError from '../../common/errors/app.error';
import {
  ActivityLogService,
  type ActivityLogMetadata,
  type FieldChange,
} from '../../common/services/activity-log.service';
import { PrismaService } from '../../common/services/prisma.service';
import type {
  LoyaltyMissionAdminView,
  LoyaltyMissionAwardView,
  LoyaltyMissionOverviewView,
} from './loyalty-mission.interface';
import { countingWindow, missionPeriod } from './loyalty-mission.policy';

export const LOYALTY_MISSION_MESSAGES = {
  NOT_FOUND: 'Loyalty mission not found',
  NOTHING_TO_CHANGE:
    'Provide at least one of title, description, rewardCredits, active',
} as const;

const AWARDS_PAGE_SIZE = 50;

/**
 * Loyalty mission administration (ADMIN, SUPERADMIN) and the caller's own
 * missions, progress and rewards. A mission starts when it is created:
 * earlier completions never count. Changing the reward or switching a
 * mission off applies to rewards from then on.
 */
@Injectable()
export class LoyaltyMissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async create(
    input: {
      title: string;
      description?: string | null;
      recurrence: LoyaltyMissionRecurrence;
      requiredCompletions: number;
      rewardCredits: number;
      active?: boolean;
    },
    actor: ActivityLogMetadata,
  ): Promise<LoyaltyMissionAdminView> {
    return this.prisma.$transaction(async (tx) => {
      const mission = await tx.loyaltyMission.create({
        data: {
          title: input.title.trim(),
          description: input.description?.trim() || null,
          recurrence: input.recurrence,
          requiredCompletions: input.requiredCompletions,
          rewardCredits: input.rewardCredits,
          active: input.active ?? true,
          startsAt: new Date(),
        },
      });
      await this.activityLog.logActivity(
        {
          tableName: 'LoyaltyMission',
          recordId: mission.id,
          action: 'create',
          changes: (
            [
              'title',
              'recurrence',
              'requiredCompletions',
              'rewardCredits',
              'active',
            ] as const
          ).map((field) => ({
            fieldName: field,
            oldValue: null,
            newValue: String(mission[field]),
          })),
          metadata: actor,
        },
        tx,
      );
      return this.toAdminView(mission, 0);
    });
  }

  async list(): Promise<LoyaltyMissionAdminView[]> {
    const missions = await this.prisma.loyaltyMission.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { awards: true } } },
    });
    return missions.map((m) => this.toAdminView(m, m._count.awards));
  }

  async get(id: string): Promise<LoyaltyMissionAdminView> {
    const mission = await this.prisma.loyaltyMission.findUnique({
      where: { id },
      include: { _count: { select: { awards: true } } },
    });
    if (!mission) throw AppError.notFound(LOYALTY_MISSION_MESSAGES.NOT_FOUND);
    return this.toAdminView(mission, mission._count.awards);
  }

  async update(
    id: string,
    input: {
      title?: string;
      description?: string | null;
      rewardCredits?: number;
      active?: boolean;
    },
    actor: ActivityLogMetadata,
  ): Promise<LoyaltyMissionAdminView> {
    const data = {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined
        ? { description: input.description?.trim() || null }
        : {}),
      ...(input.rewardCredits !== undefined
        ? { rewardCredits: input.rewardCredits }
        : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    };
    if (Object.keys(data).length === 0) {
      throw AppError.badRequest(LOYALTY_MISSION_MESSAGES.NOTHING_TO_CHANGE);
    }
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "LoyaltyMission" WHERE "id" = ${id} FOR UPDATE
      `;
      if (locked.length === 0) {
        throw AppError.notFound(LOYALTY_MISSION_MESSAGES.NOT_FOUND);
      }
      const before = await tx.loyaltyMission.findUniqueOrThrow({
        where: { id },
      });
      const after = await tx.loyaltyMission.update({ where: { id }, data });
      const changes: FieldChange[] = (
        Object.keys(data) as (keyof typeof data)[]
      )
        .filter((field) => before[field] !== after[field])
        .map((field) => ({
          fieldName: field,
          oldValue: before[field] === null ? null : String(before[field]),
          newValue: after[field] === null ? null : String(after[field]),
        }));
      if (changes.length > 0) {
        await this.activityLog.logActivity(
          {
            tableName: 'LoyaltyMission',
            recordId: id,
            action: 'update',
            changes,
            metadata: actor,
          },
          tx,
        );
      }
      const awards = await tx.loyaltyMissionAward.count({
        where: { missionId: id },
      });
      return this.toAdminView(after, awards);
    });
  }

  /** The active missions with the caller's progress in their current period. */
  async overview(authId: string): Promise<LoyaltyMissionOverviewView> {
    const now = new Date();
    const [missions, total, earned] = await Promise.all([
      this.prisma.loyaltyMission.findMany({
        where: { active: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.makeupCompletion.count({ where: { authId } }),
      this.prisma.loyaltyMissionAward.aggregate({
        where: { authId },
        _sum: { rewardCredits: true },
      }),
    ]);
    const countBetween = (from: Date, to: Date | null) =>
      this.prisma.makeupCompletion.count({
        where: {
          authId,
          completedAt: { gte: from, ...(to ? { lt: to } : {}) },
        },
      });
    const week = missionPeriod(LoyaltyMissionRecurrence.WEEKLY, now, now);
    const month = missionPeriod(LoyaltyMissionRecurrence.MONTHLY, now, now);
    const [thisWeek, thisMonth] = await Promise.all([
      countBetween(week.start, week.end),
      countBetween(month.start, month.end),
    ]);

    const progress = await Promise.all(
      missions.map(async (mission) => {
        const period = missionPeriod(mission.recurrence, now, mission.startsAt);
        const window = countingWindow(period, mission.startsAt);
        const [completions, award] = await Promise.all([
          countBetween(window.from, window.to),
          this.prisma.loyaltyMissionAward.findUnique({
            where: {
              missionId_authId_periodKey: {
                missionId: mission.id,
                authId,
                periodKey: period.key,
              },
            },
          }),
        ]);
        return {
          id: mission.id,
          title: mission.title,
          description: mission.description,
          recurrence: mission.recurrence,
          requiredCompletions: mission.requiredCompletions,
          rewardCredits: mission.rewardCredits,
          period: {
            key: period.key,
            startsAt: window.from.toISOString(),
            endsAt: period.end?.toISOString() ?? null,
          },
          completions,
          remainingCompletions: Math.max(
            0,
            mission.requiredCompletions - completions,
          ),
          completed: award !== null,
          award: award && {
            id: award.id,
            credits: award.rewardCredits,
            awardedAt: award.awardedAt.toISOString(),
          },
        };
      }),
    );
    return {
      verifiedCompletions: { total, thisWeek, thisMonth },
      missions: progress,
      totalEarnedCredits: earned._sum.rewardCredits ?? 0,
    };
  }

  /** The caller's mission rewards, newest first. */
  async awards(
    authId: string,
    query: { limit?: number },
  ): Promise<LoyaltyMissionAwardView[]> {
    const awards = await this.prisma.loyaltyMissionAward.findMany({
      where: { authId },
      orderBy: [{ awardedAt: 'desc' }, { id: 'asc' }],
      take: query.limit ?? AWARDS_PAGE_SIZE,
      include: { mission: { select: { title: true, recurrence: true } } },
    });
    return awards.map((award) => this.toAwardView(award));
  }

  private toAwardView(
    award: LoyaltyMissionAward & {
      mission: { title: string; recurrence: LoyaltyMissionRecurrence };
    },
  ): LoyaltyMissionAwardView {
    return {
      id: award.id,
      missionId: award.missionId,
      title: award.mission.title,
      recurrence: award.mission.recurrence,
      periodKey: award.periodKey,
      periodStart: award.periodStart.toISOString(),
      periodEnd: award.periodEnd?.toISOString() ?? null,
      requiredCompletions: award.requiredCompletions,
      credits: award.rewardCredits,
      awardedAt: award.awardedAt.toISOString(),
    };
  }

  private toAdminView(
    mission: LoyaltyMission,
    awards: number,
  ): LoyaltyMissionAdminView {
    return {
      id: mission.id,
      title: mission.title,
      description: mission.description,
      recurrence: mission.recurrence,
      requiredCompletions: mission.requiredCompletions,
      rewardCredits: mission.rewardCredits,
      active: mission.active,
      startsAt: mission.startsAt.toISOString(),
      awards,
      createdAt: mission.createdAt.toISOString(),
      updatedAt: mission.updatedAt.toISOString(),
    };
  }
}
