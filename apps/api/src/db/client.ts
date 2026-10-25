import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { detection } from './detection.js';
import * as managed from './schema.js';

/** App tables live in `public`, PostGIS in `extensions` (design D8). */
export const SEARCH_PATH = ['public', 'extensions'] as const;

/**
 * Pool settings for every connection the app opens. The search path is set per
 * connection, so `ST_*` functions and `geometry` resolve unqualified even before
 * (or without) the database-level default that the first migration sets.
 */
export function poolConfig(databaseUrl: string, overrides: pg.PoolConfig = {}): pg.PoolConfig {
  return {
    ...overrides,
    connectionString: databaseUrl,
    options: `-c search_path=${SEARCH_PATH.join(',')}`,
  };
}

/** drizzle-kit-managed tables plus the hand-migrated `detection` table. */
const schema = { ...managed, detection };

export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(pool: pg.Pool): Database {
  return drizzle({ client: pool, schema });
}
