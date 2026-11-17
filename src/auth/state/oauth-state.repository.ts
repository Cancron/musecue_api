import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import {
  decryptSecret,
  encryptSecret,
  keyedHash,
  SECRET_PURPOSES,
} from '../../common/security/derived-secrets';

interface ConsumedRow {
  payload: string;
  expiresAt: Date;
}

/**
 * OAuth authorization states in PostgreSQL. The state parameter is stored as
 * an HMAC; the associated data (PKCE code verifier, redirect URL, request
 * metadata) is encrypted with AES-256-GCM and bound to that hash. A state is
 * consumed atomically (DELETE ... RETURNING): of concurrent callbacks
 * presenting it, only one receives it.
 */
@Injectable()
export class OAuthStateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create<T>(
    provider: string,
    state: string,
    data: T,
    ttlSeconds: number,
    now: Date = new Date(),
  ): Promise<void> {
    const stateHash = this.hash(state);
    await this.prisma.oAuthState.create({
      data: {
        provider,
        stateHash,
        payload: encryptSecret(
          SECRET_PURPOSES.OAUTH_STATE,
          JSON.stringify(data),
          `${provider}:${stateHash}`,
        ),
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
        createdAt: now,
      },
    });
  }

  /**
   * Removes the state and returns its data, or null when it does not exist,
   * was already used, has expired or cannot be decrypted.
   */
  async consume<T>(
    provider: string,
    state: string,
    now: Date = new Date(),
  ): Promise<T | null> {
    const stateHash = this.hash(state);
    const rows = await this.prisma.$queryRaw<ConsumedRow[]>`
      DELETE FROM "OAuthState"
      WHERE "stateHash" = ${stateHash} AND "provider" = ${provider}
      RETURNING "payload", "expiresAt"
    `;
    const row = rows[0];
    if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
    try {
      return JSON.parse(
        decryptSecret(
          SECRET_PURPOSES.OAUTH_STATE,
          row.payload,
          `${provider}:${stateHash}`,
        ),
      ) as T;
    } catch {
      return null;
    }
  }

  /** Removes states that expired before `before`. */
  async deleteExpired(before: Date): Promise<number> {
    const { count } = await this.prisma.oAuthState.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return count;
  }

  private hash(state: string): string {
    return keyedHash(SECRET_PURPOSES.OAUTH_STATE, state);
  }
}
