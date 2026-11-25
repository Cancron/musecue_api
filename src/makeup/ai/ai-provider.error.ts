import type { AiCallMetadata } from './ai.gateway';

/** Allowlisted metadata only: never provider text, prompts, images or headers. */
export interface AiFailureDiagnostics {
  httpStatus?: number;
  providerErrorCode?: number;
  finishReason?:
    | 'stop'
    | 'length'
    | 'error'
    | 'content_filter'
    | 'tool_calls'
    | 'other';
  completionTokens?: number;
  reasoningTokens?: number;
  contentCharacters?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export class AiProviderError extends Error {
  diagnostics?: AiFailureDiagnostics;
  /**
   * Set when the provider answered (and billed) the request but the answer
   * could not be used: its request ID, model and usage, so the cost is
   * still recorded. Not enumerable: serialized or logged errors keep only
   * the allowlisted diagnostics, never provider-supplied values.
   */
  declare billedResponse?: AiCallMetadata;

  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
    Object.defineProperty(this, 'billedResponse', {
      value: undefined,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
}

export function isRetryableAiError(error: unknown): boolean {
  return error instanceof AiProviderError ? error.retryable : true;
}
