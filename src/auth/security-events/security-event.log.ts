import { Injectable } from '@nestjs/common';
import type { Prisma, SecurityEventType } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

/**
 * Non-sensitive facts about a security event: counts, reasons, methods,
 * IDs and device labels. Never a secret, code, token, hash or key.
 */
export type SecurityEventDetails = Record<
  string,
  string | number | boolean | null | string[]
>;

/** Where and by whom an event happened. */
export interface SecurityEventContext {
  ip?: string | null;
  userAgent?: string | null;
  /** The acting sign-in session (the access token's `sid`). */
  sessionId?: string | null;
}

export interface SecurityEventView {
  id: string;
  type: SecurityEventType;
  createdAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  sessionId: string | null;
  /** Whether it was done from the session making the request. */
  currentSession: boolean;
  details: SecurityEventDetails;
}

export interface SecurityEventPage {
  items: SecurityEventView[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
}

/**
 * The security activity history of each account (SecurityEvent). Events are
 * written with `record` through the client of the change they describe, so
 * they commit (or roll back) with it; `list` reads one owner's history,
 * newest first, with a stable order (time, then ID).
 */
@Injectable()
export class SecurityEventLog {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    client: Prisma.TransactionClient | PrismaService,
    event: {
      authId: string;
      type: SecurityEventType;
      context?: SecurityEventContext;
      details?: SecurityEventDetails;
      now?: Date;
    },
  ): Promise<void> {
    await client.securityEvent.create({
      data: {
        authId: event.authId,
        type: event.type,
        sessionId: event.context?.sessionId ?? null,
        ipAddress: event.context?.ip ?? null,
        userAgent: event.context?.userAgent ?? null,
        details: event.details ?? {},
        createdAt: event.now ?? new Date(),
      },
    });
  }

  async list(
    authId: string,
    page: number,
    limit: number,
    currentSessionId?: string,
  ): Promise<SecurityEventPage> {
    const where = { authId };
    const [total, rows] = await Promise.all([
      this.prisma.securityEvent.count({ where }),
      this.prisma.securityEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          type: true,
          createdAt: true,
          ipAddress: true,
          userAgent: true,
          sessionId: true,
          details: true,
        },
      }),
    ]);
    const totalPages = Math.ceil(total / limit);
    return {
      items: rows.map((row) => ({
        ...row,
        currentSession:
          !!currentSessionId && row.sessionId === currentSessionId,
        details: (row.details ?? {}) as SecurityEventDetails,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };
  }
}
