import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIntegrationApp, type IntegrationApp } from '../testing/integration-app.js';
import { detection } from './detection.js';
import { capture, detector } from './schema.js';

/** Partition name for the UTC month containing `date`, e.g. `detection_y2026m01`. */
function partitionName(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `detection_y${String(date.getUTCFullYear())}m${month}`;
}

function addUtcMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

describe('core tables', () => {
  let ctx: IntegrationApp;
  const detectorId = `test-${randomUUID()}`;
  let captureId: string;

  beforeAll(async () => {
    ctx = await buildIntegrationApp();
    await ctx.infra.db.insert(detector).values({
      id: detectorId,
      name: 'Test detector',
      kind: 'manual',
      outputSchema: { type: 'object' },
    });
    const [parent] = await ctx.infra.db
      .insert(capture)
      .values({
        blobKey: `captures/${randomUUID()}`,
        contentType: 'image/jpeg',
        byteSize: 1,
        capturedAt: new Date(),
        meta: { test: detectorId },
      })
      .returning({ id: capture.id });
    captureId = parent?.id ?? '';
  });

  afterAll(async () => {
    const { db } = ctx.infra;
    await db.delete(detection).where(eq(detection.detectorId, detectorId));
    await db.delete(capture).where(sql`${capture.meta}->>'test' = ${detectorId}`);
    await db.delete(detector).where(eq(detector.id, detectorId));
    await ctx.app.close();
  });

  describe('capture (F1.2 8.1)', () => {
    it('inserts and reads back a capture with a WGS84 point', async () => {
      const [created] = await ctx.infra.db
        .insert(capture)
        .values({
          blobKey: `captures/${randomUUID()}`,
          contentType: 'image/jpeg',
          byteSize: 1024,
          capturedAt: new Date('2026-03-01T10:00:00Z'),
          geom: { x: 13.4, y: 52.5 },
          meta: { test: detectorId },
        })
        .returning();
      const id = created?.id ?? '';

      const [read] = await ctx.infra.db.select().from(capture).where(eq(capture.id, id));
      expect(read).toMatchObject({
        status: 'pending',
        contentType: 'image/jpeg',
        byteSize: 1024,
        capturedAt: new Date('2026-03-01T10:00:00Z'),
        geom: { x: 13.4, y: 52.5 },
        idempotencyKey: null,
      });

      const { rows } = await ctx.infra.pool.query<{ srid: number; type: string }>(
        `SELECT ST_SRID(geom) AS srid, format_type(a.atttypid, a.atttypmod) AS type
           FROM capture, pg_attribute a
          WHERE capture.id = $1 AND a.attrelid = 'capture'::regclass AND a.attname = 'geom'`,
        [id],
      );
      expect(rows[0]).toEqual({ srid: 4326, type: 'geometry(Point,4326)' });
    });

    it('stores captures without a location', async () => {
      const [created] = await ctx.infra.db
        .insert(capture)
        .values({
          blobKey: `captures/${randomUUID()}`,
          contentType: 'image/png',
          byteSize: 1,
          capturedAt: new Date(),
          meta: { test: detectorId },
        })
        .returning({ geom: capture.geom });

      expect(created?.geom).toBeNull();
    });

    it('has a GiST index on capture.geom', async () => {
      const { rows } = await ctx.infra.pool.query<{ am: string }>(
        `SELECT am.amname AS am FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
          WHERE c.relname = 'capture_geom_gist'`,
      );

      expect(rows).toEqual([{ am: 'gist' }]);
    });
  });

  describe('detection partitions and indexes (F1.2 8.2)', () => {
    it('is range-partitioned on observed_at', async () => {
      const { rows } = await ctx.infra.pool.query<{ def: string }>(
        `SELECT pg_get_partkeydef('detection'::regclass) AS def`,
      );

      expect(rows[0]?.def).toBe('RANGE (observed_at)');
    });

    it('has monthly partitions for the past and next 12 months plus DEFAULT', async () => {
      const { rows } = await ctx.infra.pool.query<{ name: string; bound: string }>(
        `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'detection'::regclass`,
      );
      const names = rows.map((r) => r.name);
      const now = new Date();
      const expected = Array.from({ length: 25 }, (_, i) =>
        partitionName(addUtcMonths(now, i - 12)),
      );

      expect(names).toHaveLength(26);
      expect(names).toEqual(expect.arrayContaining([...expected, 'detection_default']));
      expect(names).not.toContain(partitionName(addUtcMonths(now, -13)));
      expect(rows.find((r) => r.name === 'detection_default')?.bound).toBe('DEFAULT');
    });

    it('has GiST, BRIN and B-tree indexes on the parent table', async () => {
      const { rows } = await ctx.infra.pool.query<{ name: string; am: string; def: string }>(
        `SELECT c.relname AS name, am.amname AS am, pg_get_indexdef(c.oid) AS def
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
          WHERE i.indrelid = 'detection'::regclass`,
      );
      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

      expect(byName.detection_geom_gist?.am).toBe('gist');
      expect(byName.detection_observed_at_brin?.am).toBe('brin');
      expect(byName.detection_capture_id_idx?.def).toContain('btree (capture_id)');
      expect(byName.detection_detector_id_observed_at_idx?.def).toContain(
        'btree (detector_id, observed_at)',
      );
      expect(byName.detection_pkey?.def).toContain('(id, observed_at)');
    });
  });

  describe('detection routing through the Drizzle mapping (F1.2 8.3)', () => {
    async function insertAt(observedAt: Date): Promise<string> {
      const [row] = await ctx.infra.db
        .insert(detection)
        .values({
          captureId,
          detectorId,
          label: 'stop-sign',
          confidence: 0.9,
          bboxPx: { x: 1, y: 2, w: 30, h: 40 },
          observedAt,
        })
        .returning({ id: detection.id });
      return row?.id ?? '';
    }

    async function partitionOf(id: string): Promise<string> {
      const { rows } = await ctx.infra.pool.query<{ partition: string }>(
        'SELECT tableoid::regclass::text AS partition FROM detection WHERE id = $1',
        [id],
      );
      return rows[0]?.partition ?? '';
    }

    /** The named monthly partition when the migration created one for that month, else DEFAULT. */
    async function expectedPartition(date: Date): Promise<string> {
      const name = partitionName(date);
      const { rows } = await ctx.infra.pool.query<{ exists: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS exists',
        [name],
      );
      return rows[0]?.exists ? name : 'detection_default';
    }

    it.each([
      ['last second of January 2026', '2026-01-31T23:59:59Z'],
      ['first instant of February 2026', '2026-02-01T00:00:00Z'],
    ])('routes the %s to its month', async (_, iso) => {
      const at = new Date(iso);
      const id = await insertAt(at);

      expect(await partitionOf(id)).toBe(await expectedPartition(at));
    });

    it('splits the current month boundary between two named partitions', async () => {
      const nextMonth = addUtcMonths(new Date(), 1);
      const lastMoment = new Date(nextMonth.getTime() - 1);

      expect(await partitionOf(await insertAt(lastMoment))).toBe(partitionName(lastMoment));
      expect(await partitionOf(await insertAt(nextMonth))).toBe(partitionName(nextMonth));
    });

    it('stores an observation from three years ago in the DEFAULT partition', async () => {
      const threeYearsAgo = new Date();
      threeYearsAgo.setUTCFullYear(threeYearsAgo.getUTCFullYear() - 3);

      expect(await partitionOf(await insertAt(threeYearsAgo))).toBe('detection_default');
    });

    it('reads detections back with typed columns', async () => {
      const id = await insertAt(new Date('2026-02-01T00:00:00Z'));
      const [read] = await ctx.infra.db.select().from(detection).where(eq(detection.id, id));

      expect(read).toMatchObject({
        captureId,
        detectorId,
        bboxPx: { x: 1, y: 2, w: 30, h: 40 },
        geom: null,
        attributes: {},
        observedAt: new Date('2026-02-01T00:00:00Z'),
      });
      expect(read?.confidence).toBeCloseTo(0.9);
    });
  });
});
