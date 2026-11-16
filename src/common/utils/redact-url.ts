/** Query parameters whose values are credentials and must never be logged. */
const SENSITIVE_QUERY_PARAMS = new Set([
  'signature',
  'token',
  'access_token',
  'refresh_token',
]);

/**
 * Returns a request URL safe for logs: values of credential-like query
 * parameters (for example the signature of a download link) are replaced
 * with `[REDACTED]`. The path and other parameters are kept.
 */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;
  const params = new URLSearchParams(url.slice(queryStart + 1));
  let redacted = false;
  for (const key of [...new Set(params.keys())]) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      params.set(key, '[REDACTED]');
      redacted = true;
    }
  }
  return redacted ? `${url.slice(0, queryStart)}?${params.toString()}` : url;
}
