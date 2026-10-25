import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrationConfig } from '../testing/integration-app.js';
import { poolConfig } from './client.js';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';

/** Runs the migrations against a brand-new database in the shared PostGIS container. */
describe('database migrations on a fresh database', () => {
  const freshDb = `migrate_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let freshUrl: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    const { DATABASE_URL } = integrationConfig();
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${freshDb}`);
    const url = new URL(DATABASE_URL);
    url.pathname = `/${freshDb}`;
    freshUrl = url.toString();
    pool = new pg.Pool(poolConfig(freshUrl, { max: 1 }));
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${freshDb} WITH (FORCE)`);
    await admin.end();
  });

  async function appliedMigrations(): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
    );
    return rows[0]?.count ?? 0;
  }

  it('starts without PostGIS', async () => {
    const { rows } = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'postgis'");

    expect(rows).toHaveLength(0);
  });

  it('installs PostGIS into the extensions schema, not public (design D8)', async () => {
    await runMigrations(pool);

    const { rows } = await pool.query<{ schema: string }>(
      `SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'postgis'`,
    );
    expect(rows).toEqual([{ schema: 'extensions' }]);
  });

  it('keeps spatial_ref_sys out of public, so drizzle-kit sees no foreign tables', async () => {
    const { rows } = await pool.query<{ inPublic: boolean; inExtensions: boolean }>(
      `SELECT to_regclass('public.spatial_ref_sys') IS NOT NULL AS "inPublic",
              to_regclass('extensions.spatial_ref_sys') IS NOT NULL AS "inExtensions"`,
    );

    expect(rows[0]).toEqual({ inPublic: false, inExtensions: true });
  });

  it('resolves ST_MakePoint without schema qualification', async () => {
    const { rows } = await pool.query<{ wkt: string }>(
      'SELECT ST_AsText(ST_MakePoint(13.4, 52.5)) AS wkt',
    );

    expect(rows[0]?.wkt).toBe('POINT(13.4 52.5)');
  });

  it('sets the database default search path for clients that set none (psql, pgAdmin)', async () => {
    const plain = new pg.Client({ connectionString: freshUrl });
    await plain.connect();
    try {
      const { rows } = await plain.query<{ wkt: string }>(
        'SELECT ST_AsText(ST_MakePoint(1, 2)) AS wkt',
      );
      expect(rows[0]?.wkt).toBe('POINT(1 2)');
    } finally {
      await plain.end();
    }
  });

  it('records every migration once, and a second run is a no-op', async () => {
    const journal = JSON.parse(
      await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    const before = await appliedMigrations();

    await runMigrations(pool);

    expect(before).toBe(journal.entries.length);
    expect(await appliedMigrations()).toBe(before);
  });
});
