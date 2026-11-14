import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import type { Request } from 'express';
import { PRIVACY_EXPORT_IDEMPOTENCY_KEY_PATTERN } from '../privacy-export.constants';

/** The raw `Idempotency-Key` request header; pair it with IdempotencyKeyPipe. */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): unknown =>
    context.switchToHttp().getRequest<Request>().headers['idempotency-key'],
);

/**
 * Validates the optional `Idempotency-Key` header: 1-128 characters of
 * letters, digits, `_`, `.`, `:` or `-` (a UUID fits). Repeated headers,
 * which Express joins with `, `, are rejected.
 */
@Injectable()
export class IdempotencyKeyPipe implements PipeTransform<
  unknown,
  string | undefined
> {
  transform(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (
      typeof value !== 'string' ||
      !PRIVACY_EXPORT_IDEMPOTENCY_KEY_PATTERN.test(value)
    ) {
      throw new BadRequestException(
        'Idempotency-Key must be 1-128 characters of letters, digits, "_", ".", ":" or "-"',
      );
    }
    return value;
  }
}

/**
 * For endpoints that take no request body. The owner always comes from the
 * access token, so any supplied field (for example a user ID) is rejected
 * rather than silently ignored.
 */
@Injectable()
export class EmptyBodyPipe implements PipeTransform<unknown, void> {
  transform(value: unknown): void {
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0);
    if (!empty) {
      throw new BadRequestException('This endpoint does not accept a body');
    }
  }
}
