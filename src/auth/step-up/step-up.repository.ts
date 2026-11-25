import { Injectable } from '@nestjs/common';
import type { Prisma, StepUpAction, StepUpMethod } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

export interface StoredApproval {
  id: string;
  authId: string;
  sessionId: string;
  action: StepUpAction;
  method: StepUpMethod;
  expiresAt: Date;
}

export interface NewApproval {
  authId: string;
  sessionId: string;
  action: StepUpAction;
  method: StepUpMethod;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface StoredStepUpChallenge {
  id: string;
  authId: string;
  sessionId: string;
  action: StepUpAction;
  codeVerifier: string;
  redirectUrl: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface NewStepUpChallenge {
  authId: string;
  sessionId: string;
  action: StepUpAction;
  stateHash: string;
  codeVerifier: string;
  redirectUrl: string | null;
  createdAt: Date;
  expiresAt: Date;
}

type Client = Prisma.TransactionClient | PrismaService;

/**
 * Step-up approvals and Google re-authentication challenges in PostgreSQL
 * (both infrastructure modes). Tokens and OAuth states are identified by
 * their SHA-256 only.
 */
@Injectable()
export class StepUpRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createApproval(
    approval: NewApproval,
    client: Client = this.prisma,
  ): Promise<void> {
    await client.stepUpApproval.create({ data: approval });
  }

  findApproval(tokenHash: string): Promise<StoredApproval | null> {
    return this.prisma.stepUpApproval.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        authId: true,
        sessionId: true,
        action: true,
        method: true,
        expiresAt: true,
      },
    });
  }

  async touchApproval(id: string, now: Date): Promise<void> {
    await this.prisma.stepUpApproval.update({
      where: { id },
      data: { lastUsedAt: now },
    });
  }

  /** Whether the user's sign-in session is still signed in. */
  async isSessionActive(
    authId: string,
    sessionId: string,
    now: Date,
  ): Promise<boolean> {
    const active = await this.prisma.refreshSession.count({
      where: { authId, sessionId, revokedAt: null, expiresAt: { gt: now } },
    });
    return active > 0;
  }

  async createChallenge(challenge: NewStepUpChallenge): Promise<void> {
    await this.prisma.stepUpChallenge.create({ data: challenge });
  }

  /** A challenge by its state hash, without using it (browser redirect). */
  peekChallenge(stateHash: string): Promise<StoredStepUpChallenge | null> {
    return this.prisma.stepUpChallenge.findUnique({
      where: { stateHash },
      select: CHALLENGE_SELECT,
    });
  }

  /**
   * Marks the challenge used and returns it - only the first caller for a
   * state gets it (one conditional UPDATE); null when unknown or already
   * used.
   */
  async consumeChallenge(
    stateHash: string,
    now: Date,
  ): Promise<StoredStepUpChallenge | null> {
    const rows = await this.prisma.$queryRaw<StoredStepUpChallenge[]>`
      UPDATE "StepUpChallenge" SET "consumedAt" = ${now}
      WHERE "stateHash" = ${stateHash} AND "consumedAt" IS NULL
      RETURNING "id", "authId", "sessionId", "action", "codeVerifier",
        "redirectUrl", "expiresAt", "consumedAt"
    `;
    return rows[0] ?? null;
  }

  /** Removes approvals and challenges that ended before `before`. */
  async deleteStale(before: Date): Promise<number> {
    const approvals = await this.prisma.stepUpApproval.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    const challenges = await this.prisma.stepUpChallenge.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return approvals.count + challenges.count;
  }
}

const CHALLENGE_SELECT = {
  id: true,
  authId: true,
  sessionId: true,
  action: true,
  codeVerifier: true,
  redirectUrl: true,
  expiresAt: true,
  consumedAt: true,
} as const;
