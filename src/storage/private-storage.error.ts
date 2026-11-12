export type PrivateStorageErrorCode =
  /** The object does not exist in the provider. */
  | 'OBJECT_NOT_FOUND'
  /** A write would overwrite an existing object (keys are write-once). */
  | 'OBJECT_ALREADY_EXISTS'
  /** The key is malformed or would escape the provider's namespace. */
  | 'INVALID_STORAGE_KEY'
  /** A stored record names a provider that is not registered. */
  | 'UNKNOWN_STORAGE_PROVIDER'
  /** Missing/invalid configuration, missing bucket, or a public bucket. */
  | 'STORAGE_MISCONFIGURED'
  /** The provider rejected the server credentials. */
  | 'STORAGE_ACCESS_DENIED'
  /** The provider refused the object (size limit, MIME policy, bad request). */
  | 'STORAGE_REJECTED'
  /** The provider did not answer within the configured timeout. */
  | 'STORAGE_TIMEOUT'
  /** Network failure, rate limiting, or a provider-side 5xx. */
  | 'STORAGE_UNAVAILABLE';

export type PrivateStorageOperation = 'put' | 'get' | 'delete';

/** Fixed messages only: provider text, URLs, keys and credentials never reach `message`. */
const SAFE_MESSAGES: Readonly<Record<PrivateStorageErrorCode, string>> = {
  OBJECT_NOT_FOUND: 'Stored image was not found',
  OBJECT_ALREADY_EXISTS: 'Stored image already exists',
  INVALID_STORAGE_KEY: 'Invalid private image storage key',
  UNKNOWN_STORAGE_PROVIDER: 'Private image storage provider is not available',
  STORAGE_MISCONFIGURED: 'Private image storage is misconfigured',
  STORAGE_ACCESS_DENIED: 'Private image storage denied access',
  STORAGE_REJECTED: 'Private image storage rejected the request',
  STORAGE_TIMEOUT: 'Private image storage timed out',
  STORAGE_UNAVAILABLE: 'Private image storage is temporarily unavailable',
};

const RETRYABLE_CODES: ReadonlySet<PrivateStorageErrorCode> = new Set([
  'STORAGE_TIMEOUT',
  'STORAGE_UNAVAILABLE',
]);

export interface PrivateStorageErrorDetails {
  provider?: string;
  operation?: PrivateStorageOperation;
  /** HTTP status reported by a remote provider, when there was one. */
  httpStatus?: number;
  /** Original error, kept for debugging. Never serialized into `message`. */
  cause?: unknown;
}

export class PrivateStorageError extends Error {
  readonly retryable: boolean;
  readonly provider?: string;
  readonly operation?: PrivateStorageOperation;
  readonly httpStatus?: number;

  constructor(
    readonly code: PrivateStorageErrorCode,
    details: PrivateStorageErrorDetails = {},
  ) {
    super(SAFE_MESSAGES[code], { cause: details.cause });
    this.name = 'PrivateStorageError';
    this.retryable = RETRYABLE_CODES.has(code);
    this.provider = details.provider;
    this.operation = details.operation;
    this.httpStatus = details.httpStatus;
  }

  /** Returns a copy annotated with provider/operation context, keeping the code. */
  withContext(
    provider: string,
    operation: PrivateStorageOperation,
  ): PrivateStorageError {
    if (this.provider === provider && this.operation === operation) return this;
    return new PrivateStorageError(this.code, {
      provider: this.provider ?? provider,
      operation: this.operation ?? operation,
      httpStatus: this.httpStatus,
      cause: this.cause,
    });
  }
}

export function isPrivateStorageError(
  error: unknown,
): error is PrivateStorageError {
  return error instanceof PrivateStorageError;
}

/** True when the object is absent or its key can never resolve to an object. */
export function isMissingPrivateObject(error: unknown): boolean {
  return (
    error instanceof PrivateStorageError &&
    (error.code === 'OBJECT_NOT_FOUND' || error.code === 'INVALID_STORAGE_KEY')
  );
}
