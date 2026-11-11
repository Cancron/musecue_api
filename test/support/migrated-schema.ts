import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pgModule from 'pg';

/**
 * Helpers for tests that need a real PostgreSQL database.
 *
 * Every test schema is a fresh, randomly named PostgreSQL schema built by
 * running the repository's migration files in order, and is dropped
 * afterwards. Tests therefore never read or modify existing data, but they do
 * need CREATE privileges on the database named by TEST_DATABASE_URL.
 */

/** Minimal typing for the parts of `pg` used here (`@types/pg` is not installed). */
interface PgClient {
  connect(): Promise<void>;
  query<Row = Record<string, unknown>>(sql: string): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}
const { Client } = pgModule as unknown as {
  Client: new (config: { connectionString: string }) => PgClient;
};

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** `describe` when TEST_DATABASE_URL is set, otherwise a reported skip. */
export const describeWithDatabase = TEST_DATABASE_URL
  ? describe
  : describe.skip;

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');

export const migrationNames = (): string[] =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/** A client whose unqualified names resolve inside `schema`. */
export async function connectToSchema(schema: string): Promise<PgClient> {
  const client = new Client({ connectionString: requireUrl() });
  await client.connect();
  await client.query(`SET search_path TO ${quote(schema)}`);
  return client;
}

export async function createSchema(): Promise<string> {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const client = new Client({ connectionString: requireUrl() });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
  } finally {
    await client.end();
  }
  return schema;
}

export async function applyMigrations(
  schema: string,
  names: string[],
): Promise<void> {
  const client = await connectToSchema(schema);
  try {
    for (const name of names) {
      await client.query(
        readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'),
      );
    }
  } finally {
    await client.end();
  }
}

export async function dropSchema(schema: string): Promise<void> {
  const client = new Client({ connectionString: requireUrl() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
  } finally {
    await client.end();
  }
}

function requireUrl(): string {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  return TEST_DATABASE_URL;
}
