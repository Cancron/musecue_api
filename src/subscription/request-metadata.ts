import type { Request } from 'express';
import type { ActivityLogMetadata } from '../common/services/activity-log.service';

const firstHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/** Audit metadata for a request, read the same way AuthController does. */
export function requestMetadata(req: Request): ActivityLogMetadata {
  return {
    ip: req.ip || 'unknown',
    userAgent: req.headers['user-agent'] || 'unknown',
    device:
      firstHeader(req.headers['x-device']) ||
      firstHeader(req.headers['x-device-id']) ||
      firstHeader(req.headers['sec-ch-ua-platform']),
  };
}
