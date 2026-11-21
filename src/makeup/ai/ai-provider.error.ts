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
   * Set when the provider already produced (and billed) a response before
   * the request failed (e.g. truncated, filtered or invalid output): its
   * generation ID, model and usage, so the usage can be recorded.
   */
  billedResponse?: AiCallMetadata;

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
