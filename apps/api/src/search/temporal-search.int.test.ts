import { randomUUID } from 'node:crypto';
import type { DetectionFilter } from '@gis-vision/schemas';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detection } from '../db/detection.js';
import type { Point } from '../db/geometry.js';
import { capture } from '../db/schema.js';
import { buildIntegrationApp, type IntegrationApp } from '../testing/integration-app.js';
import { searchCaptures } from './capture-search.js';
import { detectionSearchQuery, searchDetections } from './detection-search.js';

/** First instant of the UTC month `offset` months from `date`. */
function monthStart(date: Date, offset = 0): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
}

/** Partition name for the UTC month of `date`, e.g. `detection_y2026m03`. */
function partitionOf(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `detection_y${String(date.getUTCFullYear())}m${month}`;
}

/** Every `Relation Name` in an `EXPLAIN (FORMAT JSON)` plan. */
function relationNames(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) {
      relationNames(item, found);
    }
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'Relation Name' && typeof value === 'string') {
        found.add(value);
      } else {
        relationNames(value, found);
      }
    }
  }
  return found;
}

describe('temporal search (F2.4)', () => {
  let ctx: IntegrationApp;
  const captures: string[] = [];
  const run = randomUUID().slice(0, 8);
  const names = new Map<string, string>();
  // A remote area, so the spatial filter isolates this file's rows.
  const PLACE: Point = { x: -100.5, y: -70.5 };
  const BOX = { west: -101, south: -71, east: -100, north: -70 };
  const threeYearsAgo = new Date(Date.UTC(new Date().getUTCFullYear() - 3, 5, 15, 12));

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

  async function createCapture(capturedAt: string, geom: Point | null = PLACE): Promise<string> {
    const [row] = await ctx.infra.db
      .insert(capture)
      .values({
        status: 'ready',
        blobKey: `images/${randomUUID()}`,
        contentType: 'image/png',
        byteSize: 1,
        capturedAt: new Date(capturedAt),
        geom,
      })
      .returning({ id: capture.id });
    if (!row) {
      throw new Error('capture insert returned no row');
    }
    captures.push(row.id);
    return row.id;
  }

  async function addDetection(
    name: string,
    observedAt: Date | string,
    options: { own?: Point | null; detectorId?: string } = {},
  ): Promise<void> {
    const captureId = await createCapture('2026-01-15T00:00:00Z');
    const [row] = await ctx.infra.db
      .insert(detection)
      .values({
        captureId,
        detectorId: options.detectorId ?? 'manual',
        label: `${run}:${name}`,
        bboxPx: { x: 0, y: 0, w: 1, h: 1 },
        geom: options.own ?? null,
        observedAt: new Date(observedAt),
      })
      .returning({ id: detection.id });
    if (!row) {
      throw new Error('detection insert returned no row');
    }
    names.set(row.id, name);
  }

  /** Names of this file's detections matching the filter (always within `BOX`). */
  async function found(filter: DetectionFilter): Promise<string[]> {
    const page = await searchDetections(ctx.infra.db, { bbox: BOX, ...filter }, 100);
    return page.hits.flatMap((hit) => names.get(hit.row.id) ?? []);
  }

  beforeAll(async () => {
    await addDetection('january last second', '2026-01-31T23:59:59Z');
    await addDetection('february first second', '2026-02-01T00:00:00Z', { own: PLACE });
    await addDetection('three years ago', threeYearsAgo);
    await addDetection('march manual', '2026-03-10T00:00:00Z');
    await addDetection('march outside the box', '2026-03-10T00:00:00Z', { own: { x: 0, y: 0 } });
  });

  describe('time range (4.1)', () => {
    it('is half-open at a month boundary', async () => {
      expect(
        await found({
          observedFrom: new Date('2026-01-01T00:00:00Z'),
          observedTo: new Date('2026-02-01T00:00:00Z'),
        }),
      ).toEqual(['january last second']);
    });

    it('includes the start instant', async () => {
      expect(
        await found({
          observedFrom: new Date('2026-02-01T00:00:00Z'),
          observedTo: new Date('2026-02-02T00:00:00Z'),
        }),
      ).toEqual(['february first second']);
    });

    it('accepts either bound alone', async () => {
      expect(await found({ observedTo: new Date('2026-02-01T00:00:00Z') })).toEqual([
        'three years ago',
        'january last second',
      ]);
      expect(await found({ observedFrom: new Date('2026-03-01T00:00:00Z') })).toEqual([
        'march manual',
      ]);
    });

    it('returns an observation from three years ago like any other', async () => {
      const from = new Date(threeYearsAgo.getTime() - 86_400_000);
      const to = new Date(threeYearsAgo.getTime() + 86_400_000);

      expect(await found({ observedFrom: from, observedTo: to })).toEqual(['three years ago']);
    });

    it('combines space, time and detector', async () => {
      const march = {
        observedFrom: new Date('2026-03-01T00:00:00Z'),
        observedTo: new Date('2026-04-01T00:00:00Z'),
      };

      expect(await found({ ...march, detectorId: 'manual' })).toEqual(['march manual']);
      expect(await found({ ...march, detectorId: 'no-such-detector' })).toEqual([]);
    });

    it('rejects an empty range through GraphQL', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query:
            '{ detections(filter: { observedFrom: "2026-01-01T00:00:00Z", observedTo: "2026-01-01T00:00:00Z" }) { edges { node { id } } } }',
        },
      });
      const body = res.json<{
        errors?: { extensions?: { code?: string; issues?: { path: string }[] } }[];
      }>();

      expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(body.errors?.[0]?.extensions?.issues?.map((issue) => issue.path)).toEqual([
        'filter.observedTo',
      ]);
    });

    it('filters captures by capture time, half-open', async () => {
      const early = await createCapture('2026-05-31T23:59:59Z');
      const late = await createCapture('2026-06-01T00:00:00Z');

      const page = await searchCaptures(
        ctx.infra.db,
        {
          bbox: BOX,
          capturedFrom: new Date('2026-05-01T00:00:00Z'),
          capturedTo: new Date('2026-06-01T00:00:00Z'),
        },
        100,
      );
      const ids = page.hits.map((hit) => hit.row.id);

      expect(ids).toContain(early);
      expect(ids).not.toContain(late);
    });

    it('filters captures by time through GraphQL', async () => {
      const at = await createCapture('2026-07-15T12:00:00Z');
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: `{ captures(filter: { bbox: { west: -101, south: -71, east: -100, north: -70 }, capturedFrom: "2026-07-15T00:00:00Z", capturedTo: "2026-07-16T00:00:00Z" }) { edges { node { id capturedAt } } } }`,
        },
      });
      const body = res.json<{ data: { captures: { edges: { node: { id: string } }[] } } }>();

      expect(body.data.captures.edges.map((edge) => edge.node.id)).toEqual([at]);
    });
  });

  describe('partition pruning (4.2)', () => {
    /** The relations Postgres would read for the search's own query. */
    async function plannedRelations(filter: DetectionFilter): Promise<string[]> {
      const query = detectionSearchQuery(ctx.infra.db, filter, 51);
      const result = await ctx.infra.db.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
      const plan = result.rows[0]?.['QUERY PLAN'];
      return [...relationNames(plan)].sort();
    }

    const now = new Date();
    const month = { observedFrom: monthStart(now), observedTo: monthStart(now, 1) };
    const fiveYearsBack = {
      observedFrom: new Date(Date.UTC(now.getUTCFullYear() - 5, 2, 1)),
      observedTo: new Date(Date.UTC(now.getUTCFullYear() - 5, 3, 1)),
    };

    it.each([
      ['without a spatial filter', {}],
      ['with a bounding box (both branches)', { bbox: BOX }],
      [
        'with a radius (both branches)',
        {
          near: {
            center: { type: 'Point' as const, coordinates: [-100.5, -70.5] as [number, number] },
            radiusMeters: 1000,
          },
        },
      ],
    ])('reads only that month for a one-month range %s', async (_, spatial) => {
      expect(await plannedRelations({ ...spatial, ...month })).toEqual(
        ['capture', partitionOf(now)].sort(),
      );
    });

    it('reads only the default partition for a month five years back', async () => {
      expect(await plannedRelations({ bbox: BOX, ...fiveYearsBack })).toEqual([
        'capture',
        'detection_default',
      ]);
    });

    it('reads every partition without a time range', async () => {
      const relations = await plannedRelations({ bbox: BOX });

      expect(relations).toContain('detection_default');
      expect(relations.filter((name) => name.startsWith('detection_y')).length).toBeGreaterThan(20);
    });
  });
});
