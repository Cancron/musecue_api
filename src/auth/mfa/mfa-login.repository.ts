import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

export interface StoredMfaChallenge {
  id: string;
  authId: string;
  provider: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface StoredTrustedDevice {
  id: string;
  tokenHash: string;
  name: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface NewMfaChallenge {
  authId: string;
  tokenHash: string;
  provider: 'local' | 'google';
  ipAddress: string | null;
  userAgent: string | null;
  device: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface NewTrustedDevice {
  authId: string;
  tokenHash: string;
  name: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
}

const CHALLENGE_SELECT = {
  id: true,
  authId: true,
  provider: true,
  expiresAt: true,
  consumedAt: true,
} as const;

const DEVICE_SELECT = {
  id: true,
  tokenHash: true,
  name: true,
  ipAddress: true,
  userAgent: true,
  createdAt: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
} as const;

/**
 * Sign-in MFA state in PostgreSQL: login challenges and trusted devices,
 * each identified by the SHA-256 of a random token (no key involved).
 * Consuming a challenge runs inside the MFA verification transaction (under
 * the user's row lock), so it commits together with the accepted code.
 */
@Injectable()
export class MfaLoginRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Whether the account has MFA enabled (read fresh on every sign-in). */
  async isMfaEnabled(authId: string): Promise<boolean> {
    const security = await this.prisma.authSecurity.findUnique({
      where: { authId },
      select: { mfaEnabled: true },
    });
    return security?.mfaEnabled ?? false;
  }

  async createChallenge(challenge: NewMfaChallenge): Promise<void> {
    await this.prisma.mfaLoginChallenge.create({ data: challenge });
  }

  findChallenge(tokenHash: string): Promise<StoredMfaChallenge | null> {
    return this.prisma.mfaLoginChallenge.findUnique({
      where: { tokenHash },
      select: CHALLENGE_SELECT,
    });
  }

  /** Re-reads a challenge with a row lock, inside the verification transaction. */
  async lockChallenge(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<StoredMfaChallenge | null> {
    const rows = await tx.$queryRaw<StoredMfaChallenge[]>`
      SELECT "id", "authId", "provider", "expiresAt", "consumedAt"
      FROM "MfaLoginChallenge" WHERE "id" = ${id}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /** Marks the challenge used; false if it was already used or expired. */
  async consumeChallenge(
    tx: Prisma.TransactionClient,
    id: string,
    now: Date,
  ): Promise<boolean> {
    const { count } = await tx.mfaLoginChallenge.updateMany({
      where: { id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    return count === 1;
  }

  createTrustedDevice(
    tx: Prisma.TransactionClient,
    device: NewTrustedDevice,
  ): Promise<StoredTrustedDevice> {
    return tx.mfaTrustedDevice.create({ data: device, select: DEVICE_SELECT });
  }

  /**
   * Records a sign-in from a trusted device and returns its ID, only if the
   * token belongs to this user's device and it is neither revoked nor
   * expired (one conditional UPDATE, so a concurrent revocation wins).
   */
  async useTrustedDevice(
    authId: string,
    tokenHash: string,
    now: Date,
  ): Promise<string | null> {
    const { count } = await this.prisma.mfaTrustedDevice.updateMany({
      where: { authId, tokenHash, revokedAt: null, expiresAt: { gt: now } },
      data: { lastUsedAt: now },
    });
    if (count !== 1) return null;
    const device = await this.prisma.mfaTrustedDevice.findUnique({
      where: { tokenHash },
      select: { id: true },
    });
    return device?.id ?? null;
  }

  listTrustedDevices(authId: string): Promise<StoredTrustedDevice[]> {
    return this.prisma.mfaTrustedDevice.findMany({
      where: { authId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: DEVICE_SELECT,
    });
  }

  /**
   * Revokes the user's device (repeating it is harmless); null when the user
   * has no such device, including another user's device.
   */
  async revokeTrustedDevice(
    authId: string,
    id: string,
    now: Date,
  ): Promise<StoredTrustedDevice | null> {
    await this.prisma.mfaTrustedDevice.updateMany({
      where: { id, authId, revokedAt: null },
      data: { revokedAt: now },
    });
    return this.prisma.mfaTrustedDevice.findFirst({
      where: { id, authId },
      select: DEVICE_SELECT,
    });
  }

  /** Removes challenges and devices that ended before `before`. */
  async deleteStale(before: Date): Promise<number> {
    const challenges = await this.prisma.mfaLoginChallenge.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    const devices = await this.prisma.mfaTrustedDevice.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: before } }, { revokedAt: { lt: before } }],
      },
    });
    return challenges.count + devices.count;
  }
}
