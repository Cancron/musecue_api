/**
 * Retry an idempotent test request or read after a socket reset. The caller
 * creates a fresh operation each time; POST callers keep the same idempotency
 * key. HTTP errors and persistent transport failures still fail the test.
 */
export async function retryCreditRequest<T>(
  request: () => PromiseLike<T>,
  label: string,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!isConnectionReset(error)) throw error;
      if (attempt === 3) {
        throw new Error(
          `${label} failed after ${attempt} ECONNRESET attempts`,
          {
            cause: error,
          },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    }
  }
  throw new Error(`${label} did not finish`);
}

function isConnectionReset(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ('code' in current && current.code === 'ECONNRESET') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** Report every failed parallel request after all siblings have settled. */
export function settledFailures<T>(
  results: readonly PromiseSettledResult<T>[],
  label: string,
): string[] {
  return results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [`${label}[${index}]: ${String(result.reason)}`]
      : [],
  );
}
