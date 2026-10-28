import { randomUUID } from 'node:crypto';
import type { Capture } from '@gis-vision/schemas';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { detection } from '../db/detection.js';
import type { Point } from '../db/geometry.js';
import { capture, detector } from '../db/schema.js';
import { createAppDeps, createInfrastructure, type Infrastructure } from '../infrastructure.js';
import {
  buildIntegrationApp,
  integrationConfig,
  type IntegrationApp,
} from '../testing/integration-app.js';

interface GraphQLBody<T> {
  data: T;
  errors?: { message: string }[];
}

const BERLIN: Point = { x: 13.4, y: 52.5 };
const BBOX = { x: 10, y: 20, w: 40, h: 30 };

describe('GraphQL core types (F2.2)', () => {
  let ctx: IntegrationApp;
  const captures: string[] = [];
  const testDetectorId = `test-ml-${randomUUID()}`;

  beforeAll(async () => {
    ctx = await buildIntegrationApp();
    await ctx.infra.db.insert(detector).values({
      id: testDetectorId,
      name: 'Test model',
      version: 3,
      kind: 'ml',
      outputSchema: { type: 'object', additionalProperties: true },
    });
  });

  afterAll(async () => {
    const { db } = ctx.infra;
    if (captures.length > 0) {
      await db.delete(detection).where(inArray(detection.captureId, captures));
      await db.delete(capture).where(inArray(capture.id, captures));
    }
    await db.delete(detector).where(eq(detector.id, testDetectorId));
    await ctx.app.close();
  });

  async function createCapture(
    options: { status?: 'pending' | 'ready'; geom?: Point | null } = {},
  ): Promise<string> {
    const [row] = await ctx.infra.db
      .insert(capture)
      .values({
        status: options.status ?? 'ready',
        blobKey: `images/${randomUUID()}`,
        contentType: 'image/png',
        byteSize: 1234,
        capturedAt: new Date('2026-03-01T10:00:00Z'),
        geom: options.geom === undefined ? BERLIN : options.geom,
      })
      .returning({ id: capture.id });
    if (!row) {
      throw new Error('capture insert returned no row');
    }
    captures.push(row.id);
    return row.id;
  }

  async function addDetection(
    captureId: string,
    values: { label: string; observedAt: string; geom?: Point; detectorId?: string },
  ): Promise<string> {
    const [row] = await ctx.infra.db
      .insert(detection)
      .values({
        captureId,
        detectorId: values.detectorId ?? 'manual',
        label: values.label,
        confidence: 0.5,
        bboxPx: BBOX,
        geom: values.geom ?? null,
        observedAt: new Date(values.observedAt),
        attributes: { note: values.label },
      })
      .returning({ id: detection.id });
    if (!row) {
      throw new Error('detection insert returned no row');
    }
    return row.id;
  }

  async function query<T>(source: string, variables: Record<string, unknown> = {}) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: source, variables },
    });
    const body = res.json<GraphQLBody<T>>();
    expect(body.errors).toBeUndefined();
    return body.data;
  }

  const CAPTURE_QUERY = /* GraphQL */ `
    query ($id: ID!) {
      capture(id: $id) {
        id
        status
        contentType
        byteSize
        capturedAt
        createdAt
        location
        imageUrl
        detections {
          id
          label
          confidence
          bbox {
            x
            y
            w
            h
          }
          location
          locationSource
          observedAt
          attributes
          capture {
            id
          }
          detector {
            id
            kind
            version
          }
        }
      }
    }
  `;

  interface CaptureResult {
    capture: {
      id: string;
      status: string;
      contentType: string;
      byteSize: number;
      capturedAt: string;
      createdAt: string;
      location: unknown;
      imageUrl: string | null;
      detections: {
        label: string;
        location: unknown;
        locationSource: string;
        observedAt: string;
        capture: { id: string };
        detector: { id: string; kind: string; version: number };
      }[];
    } | null;
  }

  describe('types and relations (2.1)', () => {
    it('reads a capture with its detections, their capture and detector', async () => {
      const captureId = await createCapture();
      await addDetection(captureId, {
        label: 'later',
        observedAt: '2026-03-01T12:00:00Z',
        detectorId: testDetectorId,
      });
      await addDetection(captureId, {
        label: 'earlier',
        observedAt: '2026-03-01T09:00:00Z',
        geom: { x: 13.41, y: 52.51 },
      });

      const { capture: result } = await query<CaptureResult>(CAPTURE_QUERY, { id: captureId });

      expect(result).toMatchObject({
        id: captureId,
        status: 'ready',
        location: { type: 'Point', coordinates: [13.4, 52.5] },
      });
      expect(result?.detections).toMatchObject([
        {
          label: 'earlier',
          location: { type: 'Point', coordinates: [13.41, 52.51] },
          locationSource: 'DETECTION',
          observedAt: '2026-03-01T09:00:00.000Z',
          capture: { id: captureId },
          detector: { id: 'manual', kind: 'manual', version: 1 },
        },
        {
          label: 'later',
          location: { type: 'Point', coordinates: [13.4, 52.5] },
          locationSource: 'CAPTURE',
          detector: { id: testDetectorId, kind: 'ml', version: 3 },
        },
      ]);
    });

    it('returns the same capture values as REST', async () => {
      const captureId = await createCapture();

      const rest = (await ctx.app.inject({ method: 'GET', url: `/captures/${captureId}` })).json<
        Capture & { imageUrl?: string }
      >();
      const { capture: graph } = await query<CaptureResult>(CAPTURE_QUERY, { id: captureId });

      expect(graph).toMatchObject({
        id: rest.id,
        status: rest.status,
        contentType: rest.contentType,
        byteSize: rest.byteSize,
        capturedAt: rest.capturedAt,
        createdAt: rest.createdAt,
        location: rest.location,
      });
      expect(graph?.imageUrl).toContain(`images/`);
    });

    it('has no location anywhere: location null and locationSource NONE', async () => {
      const captureId = await createCapture({ geom: null });
      await addDetection(captureId, { label: 'nowhere', observedAt: '2026-03-01T10:00:00Z' });

      const { capture: result } = await query<CaptureResult>(CAPTURE_QUERY, { id: captureId });

      expect(result?.location).toBeNull();
      expect(result?.detections).toMatchObject([{ location: null, locationSource: 'NONE' }]);
    });

    it('gives a pending capture no imageUrl', async () => {
      const captureId = await createCapture({ status: 'pending' });

      const { capture: result } = await query<CaptureResult>(CAPTURE_QUERY, { id: captureId });

      expect(result).toMatchObject({ status: 'pending', imageUrl: null, detections: [] });
    });

    it.each([
      ['an unknown capture', '{ capture(id: "00000000-0000-4000-8000-000000000000") { id } }'],
      ['a capture id that is not a UUID', '{ capture(id: "not-a-uuid") { id } }'],
      ['an unknown detector', '{ capture: detector(id: "no-such-detector") { id } }'],
    ])('resolves %s to null without errors', async (_, source) => {
      expect(await query<{ capture: unknown }>(source)).toEqual({ capture: null });
    });

    it('lists detectors ordered by id, including manual with its schema', async () => {
      const { detectors } = await query<{
        detectors: { id: string; name: string; kind: string; outputSchema: unknown }[];
      }>('{ detectors { id name kind outputSchema } }');
      const ids = detectors.map((item) => item.id);

      expect(ids).toEqual([...ids].sort());
      expect(detectors).toContainEqual(
        expect.objectContaining({
          id: 'manual',
          kind: 'manual',
          outputSchema: expect.objectContaining({ type: 'object' }) as unknown,
        }),
      );
    });
  });

  describe('batched relation loading (2.2)', () => {
    let counted: { infra: Infrastructure; app: Awaited<ReturnType<typeof buildApp>> };
    let statements = 0;
    const ids: string[] = [];

    beforeAll(async () => {
      const config = integrationConfig();
      const infra = createInfrastructure(config, {
        logger: {
          logQuery: () => {
            statements += 1;
          },
        },
      });
      counted = { infra, app: await buildApp({ ...createAppDeps(config, infra), logger: false }) };
      // 50 captures, one detection each, alternating between two detectors.
      for (let i = 0; i < 50; i++) {
        const captureId = await createCapture();
        await addDetection(captureId, {
          label: `n+1 ${String(i)}`,
          observedAt: '2026-03-02T10:00:00Z',
          detectorId: i % 2 === 0 ? 'manual' : testDetectorId,
        });
        ids.push(captureId);
      }
    });

    afterAll(async () => {
      await counted.app.close();
      await counted.infra.close();
    });

    /** SQL statements needed to read `n` captures with their detections' capture and detector. */
    async function statementsFor(n: number): Promise<number> {
      const fields = ids
        .slice(0, n)
        .map(
          (id, i) =>
            `c${String(i)}: capture(id: "${id}") { id detections { id capture { id status } detector { id kind } } }`,
        )
        .join('\n');
      statements = 0;
      const res = await counted.app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: `{ ${fields} }` },
      });
      const body = res.json<GraphQLBody<Record<string, { detections: unknown[] } | null>>>();
      expect(body.errors).toBeUndefined();
      expect(Object.values(body.data).every((item) => item?.detections.length === 1)).toBe(true);
      return statements;
    }

    it('issues the same number of SQL queries for 5 and for 50 detections', async () => {
      const few = await statementsFor(5);
      const many = await statementsFor(50);

      expect(many).toBe(few);
      // captures by id, detections by capture id, detectors by id
      expect(few).toBe(3);
    });
  });
});
