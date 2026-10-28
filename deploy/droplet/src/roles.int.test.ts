import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAsOwner, startDropletStack, type DropletStack } from './stack.js';

/** The SQLSTATE a statement fails with, or `undefined` when it succeeds. */
async function errorCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// Spec hosted-deployment, "Least-privilege database access"; design D3.
describe('droplet database roles (F2.5.1)', () => {
  let stack: DropletStack;

  beforeAll(async () => {
    stack = await startDropletStack();
    migrateAsOwner(stack);
  }, 180_000);

  afterAll(async () => {
    await stack.stop();
  });

  it('applies the existing migrations as gis_owner, with PostGIS in extensions', async () => {
    const owner = await stack.connect('gis_owner');
    try {
      const { rows } = await owner.query<{ schema: string; migrations: number }>(
        `SELECT n.nspname AS schema,
                (SELECT count(*) FROM drizzle.__drizzle_migrations)::int AS migrations
           FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
          WHERE e.extname = 'postgis'`,
      );
      expect(rows[0]?.schema).toBe('extensions');
      expect(rows[0]?.migrations).toBeGreaterThanOrEqual(5);
    } finally {
      await owner.end();
    }
  });

  it('gives no role superuser, role or database creation rights', async () => {
    const owner = await stack.connect('gis_owner');
    try {
      const { rows } = await owner.query(
        `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles
          WHERE rolname IN ('gis_owner', 'gis_app', 'gis_readonly') ORDER BY rolname`,
      );
      expect(rows).toEqual(
        ['gis_app', 'gis_owner', 'gis_readonly'].map((rolname) => ({
          rolname,
          rolsuper: false,
          rolcreaterole: false,
          rolcreatedb: false,
        })),
      );
    } finally {
      await owner.end();
    }
  });

  describe('gis_app', () => {
    it('inserts, reads, updates and deletes captures and partitioned detections', async () => {
      const app = await stack.connect('gis_app');
      try {
        const capture = await app.query<{ id: string }>(
          `INSERT INTO capture (status, blob_key, content_type, byte_size, captured_at, geom)
           VALUES ('ready', 'images/roles-test', 'image/png', 1, now(),
                   ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326))
           RETURNING id`,
        );
        const captureId = capture.rows[0]?.id;
        await app.query(
          `INSERT INTO detection (capture_id, detector_id, label, bbox_px, observed_at)
           VALUES ($1, 'manual', 'car', '{"x":0,"y":0,"w":1,"h":1}', now())`,
          [captureId],
        );
        await app.query(`UPDATE detection SET label = 'bus' WHERE capture_id = $1`, [captureId]);
        const read = await app.query<{ label: string; x: number }>(
          `SELECT d.label, ST_X(c.geom) AS x FROM detection d JOIN capture c ON c.id = d.capture_id
            WHERE c.id = $1`,
          [captureId],
        );
        expect(read.rows).toEqual([{ label: 'bus', x: 13.4 }]);
        await app.query('DELETE FROM detection WHERE capture_id = $1', [captureId]);
        const deleted = await app.query('DELETE FROM capture WHERE id = $1', [captureId]);
        expect(deleted.rowCount).toBe(1);
      } finally {
        await app.end();
      }
    });

    it.each([
      ['CREATE TABLE', 'CREATE TABLE intruder (id int)'],
      ['DROP TABLE', 'DROP TABLE capture'],
      ['ALTER TABLE', 'ALTER TABLE capture ADD COLUMN intruder int'],
      ['CREATE SCHEMA', 'CREATE SCHEMA intruder'],
    ])('cannot run %s', async (_, sql) => {
      const app = await stack.connect('gis_app');
      try {
        expect(await errorCode(() => app.query(sql))).toBe('42501');
      } finally {
        await app.end();
      }
    });
  });

  it('rejects the superuser over TCP', async () => {
    expect(await errorCode(() => stack.connect('postgres'))).toBe('28000');
  });

  it('publishes Postgres on the loopback interface only', () => {
    const bindings = stack.portBindings('db');

    expect(Object.keys(bindings)).toEqual(['5432/tcp']);
    expect(bindings['5432/tcp']?.map((b) => b.HostIp)).toEqual(['127.0.0.1']);
  });
});
