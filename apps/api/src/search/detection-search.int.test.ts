import { randomUUID } from 'node:crypto';
import type { DetectionFilter } from '@gis-vision/schemas';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detection } from '../db/detection.js';
import type { Point } from '../db/geometry.js';
import { capture } from '../db/schema.js';
import { buildIntegrationApp, type IntegrationApp } from '../testing/integration-app.js';
import { searchDetections } from './detection-search.js';

/** Points `meters` east of `origin` along its parallel (fine for small distances). */
function east(origin: Point, meters: number): Point {
  const metersPerDegree = 111_320 * Math.cos((origin.y * Math.PI) / 180);
  return { x: origin.x + meters / metersPerDegree, y: origin.y };
}

describe('detection search (F2.3)', () => {
  let ctx: IntegrationApp;
  const captures: string[] = [];
  // Every fixture uses this label prefix, and every search filters to these captures' rows.
  const run = randomUUID().slice(0, 8);
  const labels = new Map<string, string>();

  // A remote place so other tests' data never falls inside these boxes.
  const ORIGIN: Point = { x: -150.5, y: -40.5 };
  const BOX = { west: -151, south: -41, east: -150, north: -40 };

  beforeAll(async () => {
    ctx = await buildIntegrationApp();
  });

  afterAll(async () => {
    const { db } = ctx.infra;
    if (captures.length > 0) {
      await db.delete(detection).where(inArray(detection.captureId, captures));
      await db.delete(capture).where(inArray(capture.id, captures));
    }
    await ctx.app.close();
  });

  async function createCapture(geom: Point | null): Promise<string> {
    const [row] = await ctx.infra.db
      .insert(capture)
      .values({
        status: 'ready',
        blobKey: `images/${randomUUID()}`,
        contentType: 'image/png',
        byteSize: 1,
        capturedAt: new Date('2026-03-01T10:00:00Z'),
        geom,
      })
      .returning({ id: capture.id });
    if (!row) {
      throw new Error('capture insert returned no row');
    }
    captures.push(row.id);
    return row.id;
  }

  /** Adds a detection named `name`; `own` is its own point, `at` its capture's location. */
  async function fixture(
    name: string,
    options: { own?: Point; at?: Point | null; observedAt?: string },
  ): Promise<void> {
    const captureId = await createCapture(options.at ?? null);
    const [row] = await ctx.infra.db
      .insert(detection)
      .values({
        captureId,
        detectorId: 'manual',
        label: `${run}:${name}`,
        bboxPx: { x: 0, y: 0, w: 1, h: 1 },
        geom: options.own ?? null,
        observedAt: new Date(options.observedAt ?? '2026-03-01T10:00:00Z'),
      })
      .returning({ id: detection.id });
    if (!row) {
      throw new Error('detection insert returned no row');
    }
    labels.set(row.id, name);
  }

  /** Names of this run's detections matching the filter, in result order. */
  async function found(filter: DetectionFilter): Promise<string[]> {
    const page = await searchDetections(ctx.infra.db, filter, 100);
    return page.hits.flatMap((hit) => {
      const name = labels.get(hit.row.id);
      return name === undefined ? [] : [name];
    });
  }

  beforeAll(async () => {
    await fixture('own inside', { own: ORIGIN, at: null, observedAt: '2026-03-01T08:00:00Z' });
    await fixture('capture inside', { at: ORIGIN, observedAt: '2026-03-01T09:00:00Z' });
    await fixture('own outside, capture inside', { own: { x: -160, y: -40.5 }, at: ORIGIN });
    await fixture('own on east edge', {
      own: { x: -150, y: -40.5 },
      observedAt: '2026-03-01T11:00:00Z',
    });
    await fixture('no location', {});
    await fixture('500 m east', { own: east({ x: 10.25, y: 47.25 }, 500) });
    await fixture('1500 m east', { own: east({ x: 10.25, y: 47.25 }, 1500) });
    await fixture('date line east', { own: { x: 175, y: 1 } });
    await fixture('date line west', { at: { x: -175, y: 1 } });
    await fixture('greenwich', { own: { x: 0, y: 1 } });
  });

  describe('bounding box', () => {
    it('matches own points and capture fallbacks inside, edge included, in time order', async () => {
      expect(await found({ bbox: BOX })).toEqual([
        'own inside',
        'capture inside',
        'own on east edge',
      ]);
    });

    it('uses the own point when there is one, even if the capture is inside', async () => {
      expect(await found({ bbox: BOX })).not.toContain('own outside, capture inside');
    });

    it('covers both sides of the antimeridian when west > east', async () => {
      const names = await found({ bbox: { west: 170, south: 0, east: -170, north: 2 } });

      expect(names.sort()).toEqual(['date line east', 'date line west']);
    });

    it('reports where each effective location came from', async () => {
      const page = await searchDetections(ctx.infra.db, { bbox: BOX }, 100);
      const sources = Object.fromEntries(
        page.hits.flatMap((hit) => {
          const name = labels.get(hit.row.id);
          return name === undefined ? [] : [[name, [hit.locationSource, hit.location]]];
        }),
      );

      expect(sources['own inside']).toEqual(['DETECTION', ORIGIN]);
      expect(sources['capture inside']).toEqual(['CAPTURE', ORIGIN]);
    });
  });

  describe('radius', () => {
    const center = { type: 'Point' as const, coordinates: [10.25, 47.25] as [number, number] };

    it('matches within the geodesic radius only', async () => {
      expect(await found({ near: { center, radiusMeters: 1000 } })).toEqual(['500 m east']);
      expect((await found({ near: { center, radiusMeters: 2000 } })).sort()).toEqual([
        '1500 m east',
        '500 m east',
      ]);
    });

    it('matches capture fallbacks too', async () => {
      const at = { type: 'Point' as const, coordinates: [ORIGIN.x, ORIGIN.y] as [number, number] };

      expect(await found({ near: { center: at, radiusMeters: 10 } })).toEqual([
        'own inside',
        'capture inside',
      ]);
    });
  });

  describe('no location and no spatial filter', () => {
    it('never matches a spatial filter', async () => {
      const world = { west: -180, south: -90, east: 180, north: 90 };

      expect(await found({ bbox: world })).not.toContain('no location');
    });

    it('is returned without a spatial filter, with source NONE', async () => {
      const page = await searchDetections(ctx.infra.db, {}, 100);
      const hit = page.hits.find((item) => labels.get(item.row.id) === 'no location');

      // Other tests' rows may come first, so look the fixture up by its own search.
      const mine =
        hit ?? (await searchAll()).find((item) => labels.get(item.row.id) === 'no location');
      expect(mine).toMatchObject({ location: null, locationSource: 'NONE' });
    });
  });

  /** Every detection, page by page, without a spatial filter. */
  async function searchAll() {
    const page = await searchDetections(ctx.infra.db, {}, 100_000);
    return page.hits;
  }

  it('reports hasNextPage when more hits exist than requested', async () => {
    const page = await searchDetections(ctx.infra.db, { bbox: BOX }, 2);

    expect(page.hits).toHaveLength(2);
    expect(page.hasNextPage).toBe(true);
  });

  describe('geography indexes (3.2)', () => {
    it('exist on capture, the detection parent, a partition and the default partition', async () => {
      const { rows } = await ctx.infra.pool.query<{ table: string; def: string }>(
        `SELECT tablename AS table, indexdef AS def FROM pg_indexes
          WHERE indexdef LIKE '%USING gist (((geom)::geography))%'`,
      );
      const tables = rows.map((row) => row.table);

      expect(tables).toEqual(expect.arrayContaining(['capture', 'detection', 'detection_default']));
      expect(tables.some((name) => /^detection_y\d{4}m\d{2}$/.test(name))).toBe(true);
    });
  });
});
