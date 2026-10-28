import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detection } from '../db/detection.js';
import type { Point } from '../db/geometry.js';
import { capture } from '../db/schema.js';
import { buildIntegrationApp, type IntegrationApp } from '../testing/integration-app.js';

interface Page {
  edges: { cursor: string; node: { label?: string; id: string } }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface GraphQLBody {
  data?: Record<string, Page> | null;
  errors?: { extensions?: { code?: string; issues?: { path: string }[] } }[];
}

/** A 1x1 degree box around `place`, so each scenario's rows are isolated by area. */
function boxAround(place: Point) {
  return { west: place.x - 0.5, south: place.y - 0.5, east: place.x + 0.5, north: place.y + 0.5 };
}

describe('cursor pagination (F2.5)', () => {
  let ctx: IntegrationApp;
  const captures: string[] = [];

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

  async function createCapture(geom: Point): Promise<string> {
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

  /** Inserts detections (own point = `place`) in one statement, so `now()` is shared. */
  async function addDetections(
    place: Point,
    labels: string[],
    observedAt: (i: number) => Date | 'now',
  ) {
    const captureId = await createCapture(place);
    await ctx.infra.db.insert(detection).values(
      labels.map((label, i) => {
        const at = observedAt(i);
        return {
          captureId,
          detectorId: 'manual',
          label,
          bboxPx: { x: 0, y: 0, w: 1, h: 1 },
          geom: place,
          observedAt: at === 'now' ? sql`now()` : at,
        };
      }),
    );
  }

  async function graphql(query: string, variables: Record<string, unknown>): Promise<GraphQLBody> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query, variables },
    });
    return res.json<GraphQLBody>();
  }

  const DETECTIONS = /* GraphQL */ `
    query ($filter: DetectionFilter, $first: Int, $after: String) {
      detections(filter: $filter, first: $first, after: $after) {
        edges {
          cursor
          node {
            id
            label
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const CAPTURES = /* GraphQL */ `
    query ($filter: CaptureFilter, $first: Int, $after: String) {
      captures(filter: $filter, first: $first, after: $after) {
        edges {
          cursor
          node {
            id
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  async function page(
    field: 'detections' | 'captures',
    filter: unknown,
    first: number,
    after?: string | null,
  ): Promise<Page> {
    const body = await graphql(field === 'detections' ? DETECTIONS : CAPTURES, {
      filter,
      first,
      after,
    });
    expect(body.errors).toBeUndefined();
    const result = body.data?.[field];
    if (!result) {
      throw new Error(`no ${field} in response`);
    }
    return result;
  }

  /** Follows `endCursor` until `hasNextPage` is false; returns the pages. */
  async function walk(field: 'detections' | 'captures', filter: unknown, first: number) {
    const pages: Page[] = [];
    let after: string | null = null;
    do {
      const current = await page(field, filter, first, after);
      pages.push(current);
      after = current.pageInfo.hasNextPage ? current.pageInfo.endCursor : null;
    } while (after !== null && pages.length < 20);
    return pages;
  }

  it('delivers 120 matches exactly once, in order, over three pages of 50', async () => {
    const place = { x: 60.5, y: -80.5 };
    const labels = Array.from({ length: 120 }, (_, i) => `walk-${String(i).padStart(3, '0')}`);
    const start = Date.parse('2026-03-01T00:00:00Z');
    await addDetections(place, labels, (i) => new Date(start + i * 60_000));

    const pages = await walk('detections', { bbox: boxAround(place) }, 50);
    const seen = pages.flatMap((p) => p.edges.map((edge) => edge.node.label));

    expect(pages.map((p) => p.edges.length)).toEqual([50, 50, 20]);
    expect(pages.map((p) => p.pageInfo.hasNextPage)).toEqual([true, true, false]);
    expect(seen).toEqual(labels);
    expect(pages[0]?.pageInfo.endCursor).toBe(pages[0]?.edges.at(-1)?.cursor);
  });

  it('splits detections with identical now() timestamps across pages without repeats', async () => {
    const place = { x: 61.5, y: -80.5 };
    const labels = ['tie-a', 'tie-b', 'tie-c', 'tie-d', 'tie-e'];
    await addDetections(place, labels, () => 'now');

    const pages = await walk('detections', { bbox: boxAround(place) }, 2);
    const ids = pages.flatMap((p) => p.edges.map((edge) => edge.node.id));

    expect(pages.map((p) => p.edges.length)).toEqual([2, 2, 1]);
    expect(new Set(ids).size).toBe(5);
    // Equal observation times are ordered by id.
    expect(ids).toEqual([...ids].sort());
  });

  it('splits captures with identical created_at across pages without repeats', async () => {
    const place = { x: 62.5, y: -80.5 };
    const rows = await ctx.infra.db
      .insert(capture)
      .values(
        Array.from({ length: 5 }, () => ({
          status: 'ready' as const,
          blobKey: `images/${randomUUID()}`,
          contentType: 'image/png',
          byteSize: 1,
          capturedAt: new Date('2026-03-01T10:00:00Z'),
          geom: place,
        })),
      )
      .returning({ id: capture.id, createdAt: capture.createdAt });
    captures.push(...rows.map((row) => row.id));
    expect(new Set(rows.map((row) => row.createdAt.getTime())).size).toBe(1);

    const pages = await walk('captures', { bbox: boxAround(place) }, 2);
    const ids = pages.flatMap((p) => p.edges.map((edge) => edge.node.id));

    expect(pages.map((p) => p.edges.length)).toEqual([2, 2, 1]);
    expect([...ids].sort()).toEqual(rows.map((row) => row.id).sort());
    // Newest first; equal creation times by id, descending.
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it('continues after page 1 when an earlier detection is inserted meanwhile', async () => {
    const place = { x: 63.5, y: -80.5 };
    const filter = { bbox: boxAround(place) };
    await addDetections(
      place,
      ['p1', 'p2', 'p3', 'p4'],
      (i) => new Date(Date.UTC(2026, 2, 2, 10 + i)),
    );

    const first = await page('detections', filter, 2);
    await addDetections(place, ['inserted-earlier'], () => new Date(Date.UTC(2026, 2, 2, 9)));
    const second = await page('detections', filter, 2, first.pageInfo.endCursor);

    expect(first.edges.map((edge) => edge.node.label)).toEqual(['p1', 'p2']);
    expect(second.edges.map((edge) => edge.node.label)).toEqual(['p3', 'p4']);
    expect(second.pageInfo).toEqual({ hasNextPage: false, endCursor: second.edges.at(-1)?.cursor });
  });

  it('gives an empty page a null endCursor', async () => {
    const result = await page('detections', { bbox: boxAround({ x: 64.5, y: -80.5 }) }, 10);

    expect(result).toEqual({ edges: [], pageInfo: { hasNextPage: false, endCursor: null } });
  });

  describe('invalid after', () => {
    it.each([
      ['text that is not a cursor', 'not-a-cursor'],
      [
        'a forged payload',
        Buffer.from(JSON.stringify({ v: 1, k: 'detection', t: 'x', id: 'y' })).toString(
          'base64url',
        ),
      ],
    ])('rejects %s as BAD_USER_INPUT on after', async (_, after) => {
      const body = await graphql(DETECTIONS, { after });

      expect(body.data).toBeNull();
      expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(body.errors?.[0]?.extensions?.issues?.map((issue) => issue.path)).toEqual(['after']);
    });

    it('rejects a detections cursor passed to captures', async () => {
      const place = { x: 65.5, y: -80.5 };
      await addDetections(place, ['cross-1', 'cross-2'], () => 'now');
      const detections = await page('detections', { bbox: boxAround(place) }, 1);

      const body = await graphql(CAPTURES, { after: detections.pageInfo.endCursor });

      expect(body.errors?.[0]?.extensions?.issues?.map((issue) => issue.path)).toEqual(['after']);
    });
  });
});
