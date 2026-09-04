export class AiProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export function isRetryableAiError(error: unknown): boolean {
  return error instanceof AiProviderError ? error.retryable : true;
}
