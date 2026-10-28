import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detection } from '../db/detection.js';
import type { Point } from '../db/geometry.js';
import { capture } from '../db/schema.js';
import { buildIntegrationApp, type IntegrationApp } from '../testing/integration-app.js';

interface GraphQLBody<T> {
  data?: T | null;
  errors?: {
    message: string;
    path?: string[];
    extensions?: { code?: string; issues?: { path: string }[] };
  }[];
}

interface Connection<T> {
  edges: { node: T }[];
  pageInfo: { hasNextPage: boolean };
}

describe('GraphQL spatial search (F2.3)', () => {
  let ctx: IntegrationApp;
  const captures: string[] = [];
  const run = randomUUID().slice(0, 8);
  // A remote area no other test writes to.
  const PLACE: Point = { x: 120.5, y: -60.5 };
  const BOX = { west: 120, south: -61, east: 121, north: -60 };

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

  async function addDetection(captureId: string, label: string, own: Point | null, at: string) {
    await ctx.infra.db.insert(detection).values({
      captureId,
      detectorId: 'manual',
      label: `${run}:${label}`,
      bboxPx: { x: 0, y: 0, w: 1, h: 1 },
      geom: own,
      observedAt: new Date(at),
    });
  }

  async function graphql<T>(query: string, variables: Record<string, unknown> = {}) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query, variables },
    });
    return res.json<GraphQLBody<T>>();
  }

  const DETECTIONS = /* GraphQL */ `
    query ($filter: DetectionFilter, $first: Int) {
      detections(filter: $filter, first: $first) {
        edges {
          node {
            label
            location
            locationSource
            capture {
              id
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  interface DetectionNode {
    label: string;
    location: unknown;
    locationSource: string;
    capture: { id: string };
  }

  let insideCapture: string;
  let emptyCapture: string;

  beforeAll(async () => {
    insideCapture = await createCapture(PLACE);
    await addDetection(insideCapture, 'own', { x: 120.6, y: -60.6 }, '2026-03-01T08:00:00Z');
    await addDetection(insideCapture, 'fallback', null, '2026-03-01T09:00:00Z');
    await addDetection(insideCapture, 'elsewhere', { x: 0, y: 0 }, '2026-03-01T10:00:00Z');
    emptyCapture = await createCapture(null);
    await createCapture({ x: 10, y: 10 });
  });

  describe('detections (3.4)', () => {
    it('returns matches as a connection ordered by observation time', async () => {
      const body = await graphql<{ detections: Connection<DetectionNode> }>(DETECTIONS, {
        filter: { bbox: BOX },
      });

      expect(body.errors).toBeUndefined();
      expect(body.data?.detections.edges.map((edge) => edge.node)).toEqual([
        {
          label: `${run}:own`,
          location: { type: 'Point', coordinates: [120.6, -60.6] },
          locationSource: 'DETECTION',
          capture: { id: insideCapture },
        },
        {
          label: `${run}:fallback`,
          location: { type: 'Point', coordinates: [120.5, -60.5] },
          locationSource: 'CAPTURE',
          capture: { id: insideCapture },
        },
      ]);
      expect(body.data?.detections.pageInfo).toEqual({ hasNextPage: false });
    });

    it('searches by radius and by detector', async () => {
      const body = await graphql<{ detections: Connection<DetectionNode> }>(DETECTIONS, {
        filter: {
          near: { center: { type: 'Point', coordinates: [120.5, -60.5] }, radiusMeters: 100 },
          detectorId: 'manual',
        },
      });

      expect(body.data?.detections.edges.map((edge) => edge.node.label)).toEqual([
        `${run}:fallback`,
      ]);
    });

    it('limits the page with first and reports hasNextPage', async () => {
      const body = await graphql<{ detections: Connection<DetectionNode> }>(DETECTIONS, {
        filter: { bbox: BOX },
        first: 1,
      });

      expect(body.data?.detections.edges).toHaveLength(1);
      expect(body.data?.detections.pageInfo).toEqual({ hasNextPage: true });
    });

    it.each([
      [
        'an inverted box',
        { filter: { bbox: { ...BOX, south: -59, north: -61 } } },
        ['filter.bbox.south'],
      ],
      [
        'a 60 km radius',
        {
          filter: {
            near: { center: { type: 'Point', coordinates: [0, 0] }, radiusMeters: 60_000 },
          },
        },
        ['filter.near.radiusMeters'],
      ],
      [
        'a box and a radius together',
        {
          filter: {
            bbox: BOX,
            near: { center: { type: 'Point', coordinates: [0, 0] }, radiusMeters: 10 },
          },
        },
        ['filter.near'],
      ],
      ['first: 0', { first: 0 }, ['first']],
      ['first: 101', { first: 101 }, ['first']],
    ])('rejects %s as BAD_USER_INPUT naming the field', async (_, variables, paths) => {
      const body = await graphql(DETECTIONS, variables);

      expect(body.data).toBeNull();
      expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(body.errors?.[0]?.extensions?.issues?.map((issue) => issue.path)).toEqual(paths);
    });

    it('rejects an out-of-range center point through the GeoJSONPoint scalar', async () => {
      const body = await graphql(DETECTIONS, {
        filter: { near: { center: { type: 'Point', coordinates: [0, 95] }, radiusMeters: 10 } },
      });

      expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    });
  });

  describe('captures (3.5)', () => {
    const CAPTURES = /* GraphQL */ `
      query ($filter: CaptureFilter) {
        captures(filter: $filter) {
          edges {
            node {
              id
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `;

    it('returns only captures whose location is inside the box (Captures in view)', async () => {
      const body = await graphql<{ captures: Connection<{ id: string }> }>(CAPTURES, {
        filter: { bbox: BOX },
      });

      expect(body.errors).toBeUndefined();
      expect(body.data?.captures.edges.map((edge) => edge.node.id)).toEqual([insideCapture]);
    });

    it('covers the antimeridian and never matches captures without a location', async () => {
      const box = { west: 179, south: -61, east: -179, north: -60 };
      const crossing = await createCapture({ x: -179.5, y: -60.5 });

      const body = await graphql<{ captures: Connection<{ id: string }> }>(CAPTURES, {
        filter: { bbox: box },
      });
      const world = await graphql<{ captures: Connection<{ id: string }> }>(/* GraphQL */ `
        query {
          captures(filter: { bbox: { west: -180, south: -90, east: 180, north: 90 } }, first: 100) {
            edges {
              node {
                id
                location
              }
            }
          }
        }
      `);

      expect(body.data?.captures.edges.map((edge) => edge.node.id)).toEqual([crossing]);
      const ids = world.data?.captures.edges.map((edge) => edge.node.id) ?? [];
      expect(ids).not.toContain(emptyCapture);
    });
  });
});
