import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * Custom Throttler Guard that skips rate limiting for:
 * - Swagger/OpenAPI endpoints (/docs, /docs-json, etc.)
 * - Metrics endpoints (/metrics)
 * - Favicon (health handlers use their explicit @SkipThrottle decorator)
 */
@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path;

    // Skip throttling for Swagger/OpenAPI documentation
    if (
      ['/docs', '/docs-json', '/docs-yaml'].includes(path) ||
      path.startsWith('/docs/')
    ) {
      return true;
    }

    // Skip throttling for metrics endpoints (Prometheus)
    if (path === '/metrics') {
      return true;
    }

    // Skip throttling for favicon
    if (path === '/favicon.ico') {
      return true;
    }

    // Check if route has @SkipThrottle decorator
    return super.shouldSkip(context);
  }
}
