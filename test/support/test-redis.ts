import Redis from 'ioredis';

/**
 * Redis for tests that exercise the Redis drivers. They run only when
 * TEST_REDIS_URL is set (e.g. redis://127.0.0.1:6379), and use a unique key
 * prefix per run, removed afterwards.
 */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL;

/** `describe` when TEST_REDIS_URL is set, otherwise a reported skip. */
export const describeWithRedis = TEST_REDIS_URL ? describe : describe.skip;

export function redisOptions(): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
} {
  const url = new URL(TEST_REDIS_URL as string);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname.replace('/', '') || 0),
  };
}

/** Deletes every key starting with `prefix`. */
export async function deleteKeysWithPrefix(prefix: string): Promise<void> {
  const client = new Redis(redisOptions());
  try {
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(
        cursor,
        'MATCH',
        `*${prefix}*`,
        'COUNT',
        500,
      );
      cursor = next;
      if (keys.length) await client.del(...keys);
    } while (cursor !== '0');
  } finally {
    await client.quit();
  }
}
