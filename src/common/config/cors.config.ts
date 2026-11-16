import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

const DEFAULT_ORIGINS = ['http://localhost:8081', 'http://localhost:19006'];

/**
 * CORS settings used by `main.ts`. An explicit origin list makes the CORS
 * middleware answer `Vary: Origin`; route handlers must append to `Vary`
 * (`response.vary(...)`) rather than replace it.
 */
export function createCorsOptions(corsOrigins?: string): CorsOptions {
  const configuredOrigins = corsOrigins
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    origin: configuredOrigins?.length ? configuredOrigins : DEFAULT_ORIGINS,
    credentials: true,
  };
}
