import { join, resolve } from 'node:path';

/** Provider identifiers persisted in `ImageAsset.storageProvider` / `userProfile.avatarStorageProvider`. */
export const SUPABASE_STORAGE_PROVIDER_ID = 'supabase';
export const LOCAL_STORAGE_PROVIDER_ID = 'local';

export const PRIVATE_STORAGE_CONFIG = Symbol('PRIVATE_STORAGE_CONFIG');

const DEFAULT_SUPABASE_TIMEOUT_MS = 15_000;
const MIN_SUPABASE_TIMEOUT_MS = 1_000;
const MAX_SUPABASE_TIMEOUT_MS = 120_000;
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface SupabaseStorageConfig {
  /** Storage API base, e.g. `https://<project>.supabase.co/storage/v1`. */
  storageUrl: string;
  /** Server-only secret key (`sb_secret_...` or legacy service_role JWT). */
  serviceKey: string;
  bucket: string;
  timeoutMs: number;
}

export interface PrivateStorageConfig {
  /** Provider used for new uploads. Reads/deletes follow each record's provider. */
  activeProvider: string;
  localRoot: string;
  /** Undefined when Supabase variables are not set (allowed only if it is not active). */
  supabase?: SupabaseStorageConfig;
}

/** Narrow view of `ConfigService` so loading is testable without Nest. */
export interface ConfigReader {
  get<T = string>(key: string): T | undefined;
}

/**
 * Loads and validates private storage settings from server-side environment
 * variables. Throws at startup (fail fast) when the active provider is not
 * fully configured. Error messages name variables, never their values.
 */
export function loadPrivateStorageConfig(
  config: ConfigReader,
): PrivateStorageConfig {
  const activeProvider = resolveActiveProvider(config);
  const supabase = loadSupabaseConfig(
    config,
    activeProvider === SUPABASE_STORAGE_PROVIDER_ID,
  );
  return {
    activeProvider,
    localRoot: resolve(
      read(config, 'PRIVATE_UPLOAD_DIR') ??
        join(process.cwd(), '.data', 'private-images'),
    ),
    supabase,
  };
}

function resolveActiveProvider(config: ConfigReader): string {
  const configured = read(config, 'PRIVATE_STORAGE_PROVIDER')?.toLowerCase();
  // Like AI_MODE, unit/e2e test runs stay offline unless explicitly configured.
  const provider =
    configured ??
    (read(config, 'NODE_ENV') === 'test'
      ? LOCAL_STORAGE_PROVIDER_ID
      : SUPABASE_STORAGE_PROVIDER_ID);
  if (
    provider !== SUPABASE_STORAGE_PROVIDER_ID &&
    provider !== LOCAL_STORAGE_PROVIDER_ID
  ) {
    throw new Error(
      'PRIVATE_STORAGE_PROVIDER must be either "supabase" or "local"',
    );
  }
  return provider;
}

function loadSupabaseConfig(
  config: ConfigReader,
  required: boolean,
): SupabaseStorageConfig | undefined {
  const url = read(config, 'SUPABASE_URL');
  const serviceKey = read(config, 'SUPABASE_SERVICE_ROLE_KEY');
  const bucket = read(config, 'SUPABASE_STORAGE_BUCKET');

  if (!url && !serviceKey && !bucket && !required) return undefined;

  const missing = [
    ['SUPABASE_URL', url],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceKey],
    ['SUPABASE_STORAGE_BUCKET', bucket],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length || !url || !serviceKey || !bucket) {
    throw new Error(
      `Supabase private storage requires ${missing.join(', ')} to be set`,
    );
  }

  assertServerSideKey(serviceKey);
  if (!BUCKET_NAME.test(bucket)) {
    throw new Error(
      'SUPABASE_STORAGE_BUCKET must be a valid Supabase bucket name',
    );
  }

  return {
    storageUrl: `${normalizeProjectUrl(url)}/storage/v1`,
    serviceKey,
    bucket,
    timeoutMs: readTimeout(config),
  };
}

function normalizeProjectUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SUPABASE_URL must be a valid URL');
  }
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(
      'SUPABASE_URL must use https (http is allowed only for a local Supabase stack)',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'SUPABASE_URL must not contain credentials, a query or a fragment',
    );
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '') {
    throw new Error(
      'SUPABASE_URL must be the project URL, without a path such as /storage/v1',
    );
  }
  return url.origin;
}

/**
 * Private buckets are only reachable with a server-side secret. Reject keys
 * that are designed to be public so a misconfiguration fails at startup
 * instead of as opaque 403s (or, worse, prompting someone to open the bucket).
 */
function assertServerSideKey(key: string): void {
  if (key.startsWith('sb_publishable_')) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY must be a server-side secret key, not a publishable key',
    );
  }
  if (jwtRole(key) === 'anon') {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY must be the service_role key, not the anon key',
    );
  }
}

function jwtRole(key: string): string | undefined {
  const parts = key.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    if (typeof payload === 'object' && payload !== null && 'role' in payload) {
      return typeof payload.role === 'string' ? payload.role : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readTimeout(config: ConfigReader): number {
  const raw = read(config, 'SUPABASE_STORAGE_TIMEOUT_MS');
  if (raw === undefined) return DEFAULT_SUPABASE_TIMEOUT_MS;
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < MIN_SUPABASE_TIMEOUT_MS ||
    value > MAX_SUPABASE_TIMEOUT_MS
  ) {
    throw new Error(
      `SUPABASE_STORAGE_TIMEOUT_MS must be an integer between ${MIN_SUPABASE_TIMEOUT_MS} and ${MAX_SUPABASE_TIMEOUT_MS}`,
    );
  }
  return value;
}

function read(config: ConfigReader, key: string): string | undefined {
  const value = config.get<string>(key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
