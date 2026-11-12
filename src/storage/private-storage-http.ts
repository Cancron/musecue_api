import AppError from '../common/errors/app.error';
import {
  isMissingPrivateObject,
  isPrivateStorageError,
} from './private-storage.error';

export const IMAGE_STORAGE_RETRY_MESSAGE =
  'Image storage is temporarily unavailable. Please try again.';
export const IMAGE_STORAGE_FAILURE_MESSAGE = 'Image storage is unavailable';

/**
 * Maps a storage failure to a client-safe HTTP error. Provider details were
 * already logged by `PrivateImageStorageService`; none are exposed here.
 *
 * @param notFoundMessage when set (reads), a missing object becomes a 404.
 * @returns the error to throw; non-storage errors are returned unchanged.
 */
export function toImageStorageHttpError(
  error: unknown,
  notFoundMessage?: string,
): unknown {
  if (!isPrivateStorageError(error)) return error;
  if (notFoundMessage && isMissingPrivateObject(error)) {
    return AppError.notFound(notFoundMessage);
  }
  return error.retryable
    ? AppError.serviceUnavailable(IMAGE_STORAGE_RETRY_MESSAGE)
    : AppError.internalServerError(IMAGE_STORAGE_FAILURE_MESSAGE);
}
