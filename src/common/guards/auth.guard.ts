import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import config from '../config/app.config';
import { PrismaService } from '../services/prisma.service';
import { TokenVersionCache } from '../../infrastructure/token-version/token-version.cache';

interface IAccessTokenPayload {
  userId: string;
  role: string;
  tokenVersion: number;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokenVersions: TokenVersionCache,
    private readonly prismaService: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('No token found');
    }

    try {
      const payload = jwt.verify(
        token,
        config.jwt_access_secret,
      ) as IAccessTokenPayload;

      // Step 2: Check tokenVersion (cache first when enabled, DB fallback)
      const currentVersion = await this.getTokenVersion(payload.userId);

      if (currentVersion !== payload.tokenVersion) {
        throw new UnauthorizedException(
          'Token has been revoked. Please login again.',
        );
      }

      // Attach user to request for downstream use
      Object.assign(request, { user: payload });

      return true;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedException('Token has expired');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new UnauthorizedException('Invalid token');
      }
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Authentication failed');
    }
  }

  /**
   * Get token version, through the token-version cache when one is enabled
   * Fast path: cache lookup (~1-2ms, REDIS_ENABLED=true)
   * Slow path: DB lookup + cache (~10-20ms, on a cache miss or without cache)
   */
  private async getTokenVersion(userId: string): Promise<number> {
    // Try the cache first (fast path - most common with Redis)
    const cachedVersion = await this.tokenVersions.get(userId);
    if (cachedVersion !== null && cachedVersion !== undefined) {
      return cachedVersion;
    }

    // Fallback to DB (slow path - only on cache miss)
    const user = await this.prismaService.authUser.findUnique({
      where: { id: userId },
      select: { tokenVersion: true, status: true },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('User account is not active');
    }

    // Cache for 1 hour (or until a security event replaces it). Only fill an
    // empty cache entry: this database read may be older than a concurrent
    // security event (for example an account deletion) that already cached
    // a newer version, which must never be overwritten with a stale one.
    await this.tokenVersions.fill(userId, user.tokenVersion);

    return user.tokenVersion;
  }

  /**
   * Extract token from Authorization header
   * Format: Bearer <token>
   */
  private extractTokenFromHeader(request: Request): string | undefined {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return undefined;
    }

    const [type, token] = authHeader.split(' ');
    return type === 'Bearer' ? token : undefined;
  }

  /**
   * Extract token from cookies (alternative method)
   */
  private extractTokenFromCookies(request: Request): string | undefined {
    const cookies = request.cookies as Record<string, string> | undefined;
    return cookies?.accessToken;
  }
}
