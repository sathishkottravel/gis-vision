import { randomUUID } from 'node:crypto';
import type { Detection } from '@gis-vision/schemas';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detection } from '../db/detection.js';
import type { Point } from '../db/geometry.js';
import { capture, detector } from '../db/schema.js';
import type { ErrorBody } from '../http/error-handler.js';
import { buildIntegrationApp, type IntegrationApp } from '../testing/integration-app.js';

describe('detections REST API', () => {
  let ctx: IntegrationApp;
  const captures: string[] = [];
  const trafficLightId = `test-traffic-light-${randomUUID()}`;
  const CAPTURED_AT = '2026-03-01T10:00:00.000Z';
  const BERLIN: Point = { x: 13.4, y: 52.5 };
  const BBOX = { x: 10, y: 20, w: 40, h: 30 };

  beforeAll(async () => {
    ctx = await buildIntegrationApp();
    await ctx.infra.db.insert(detector).values({
      id: trafficLightId,
      name: 'Traffic light (test)',
      kind: 'ml',
      outputSchema: {
        type: 'object',
        properties: { state: { type: 'string', enum: ['red', 'amber', 'green'] } },
        required: ['state'],
      },
    });
  });

  afterAll(async () => {
    const { db } = ctx.infra;
    if (captures.length > 0) {
      await db.delete(detection).where(inArray(detection.captureId, captures));
      await db.delete(capture).where(inArray(capture.id, captures));
    }
    await db.delete(detector).where(eq(detector.id, trafficLightId));
    await ctx.app.close();
  });

  /** Inserts a capture directly; the upload flow itself is covered by the capture tests. */
  async function createCapture(
    options: { status?: 'pending' | 'ready'; geom?: Point | null } = {},
  ): Promise<string> {
    const [row] = await ctx.infra.db
      .insert(capture)
      .values({
        status: options.status ?? 'ready',
        blobKey: `images/${randomUUID()}`,
        contentType: 'image/jpeg',
        byteSize: 1,
        capturedAt: new Date(CAPTURED_AT),
        geom: options.geom === undefined ? BERLIN : options.geom,
      })
      .returning({ id: capture.id });
    if (!row) {
      throw new Error('capture insert returned no row');
    }
    captures.push(row.id);
    return row.id;
  }

  async function postDetection(captureId: string, body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/captures/${captureId}/detections`,
      payload: { detectorId: 'manual', label: 'stop-sign', bbox: BBOX, ...body },
    });
  }

  async function listDetections(captureId: string) {
    return ctx.app.inject({ method: 'GET', url: `/captures/${captureId}/detections` });
  }

  function issuePaths(body: ErrorBody): string[] {
    return body.error.issues?.map((issue) => issue.path) ?? [];
  }

  describe('POST /captures/:id/detections (F1.6 12.3)', () => {
    it('stores a valid manual annotation and returns it with its id', async () => {
      const captureId = await createCapture();

      const res = await postDetection(captureId, { confidence: 0.87, attributes: {} });
      const body = res.json<Detection>();

      expect(res.statusCode).toBe(201);
      expect(body).toMatchObject({
        captureId,
        detectorId: 'manual',
        label: 'stop-sign',
        confidence: 0.87,
        bbox: BBOX,
        attributes: {},
      });
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
      const [stored] = await ctx.infra.db.select().from(detection).where(eq(detection.id, body.id));
      expect(stored).toMatchObject({ label: 'stop-sign', bboxPx: BBOX });
    });

    it('accepts attributes that satisfy the detector schema', async () => {
      const captureId = await createCapture();

      const res = await postDetection(captureId, {
        detectorId: trafficLightId,
        label: 'traffic-light',
        attributes: { state: 'red' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json<Detection>().attributes).toEqual({ state: 'red' });
    });

    it('rejects attributes that violate the detector schema with 422 naming the field', async () => {
      const captureId = await createCapture();

      const res = await postDetection(captureId, {
        detectorId: trafficLightId,
        attributes: { state: 'blue' },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json<ErrorBody>().error.code).toBe('invalid_attributes');
      expect(issuePaths(res.json())).toEqual(['attributes.state']);
    });

    it('rejects an unknown detector with 422 naming the detector field', async () => {
      const captureId = await createCapture();

      const res = await postDetection(captureId, { detectorId: `missing-${randomUUID()}` });

      expect(res.statusCode).toBe(422);
      expect(res.json<ErrorBody>().error.code).toBe('unknown_detector');
      expect(issuePaths(res.json())).toEqual(['detectorId']);
    });

    it('rejects a detection on a pending capture with 409', async () => {
      const captureId = await createCapture({ status: 'pending' });

      const res = await postDetection(captureId, {});

      expect(res.statusCode).toBe(409);
      expect(res.json<ErrorBody>().error.code).toBe('capture_not_ready');
    });

    it.each([
      ['an unknown capture', randomUUID()],
      ['an id that is not a UUID', 'not-a-uuid'],
    ])('returns 404 for %s', async (_, captureId) => {
      const res = await postDetection(captureId, {});

      expect(res.statusCode).toBe(404);
      expect(res.json<ErrorBody>().error.code).toBe('not_found');
    });

    it.each([
      ['a negative width', { bbox: { ...BBOX, w: -5 } }, 'bbox.w'],
      ['confidence above 1', { confidence: 1.5 }, 'confidence'],
    ])('rejects %s with 400 naming the field', async (_, body, field) => {
      const captureId = await createCapture();

      const res = await postDetection(captureId, body);

      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe('invalid_request');
      expect(issuePaths(res.json())).toEqual([field]);
    });

    it('defaults the observation time to the capture time', async () => {
      const captureId = await createCapture();

      const res = await postDetection(captureId, {});

      expect(res.json<Detection>().observedAt).toBe(CAPTURED_AT);
    });

    it("defaults the location to the capture's, storing none of its own", async () => {
      const captureId = await createCapture();

      const res = await postDetection(captureId, {});
      const body = res.json<Detection>();

      expect(body.location).toEqual({ type: 'Point', coordinates: [13.4, 52.5] });
      const [stored] = await ctx.infra.db
        .select({ geom: detection.geom })
        .from(detection)
        .where(eq(detection.id, body.id));
      expect(stored?.geom).toBeNull();
    });

    it('keeps an explicit location and observation time', async () => {
      const captureId = await createCapture();

      const res = await postDetection(captureId, {
        location: { type: 'Point', coordinates: [13.41, 52.51] },
        observedAt: '2026-03-01T11:30:00+01:00',
      });

      expect(res.json()).toMatchObject({
        location: { type: 'Point', coordinates: [13.41, 52.51] },
        observedAt: '2026-03-01T10:30:00.000Z',
      });
    });

    it('has no location when neither the detection nor the capture has one', async () => {
      const captureId = await createCapture({ geom: null });

      const res = await postDetection(captureId, {});

      expect(res.json<Detection>().location).toBeNull();
    });
  });

  describe('GET /captures/:id/detections (F1.6 12.4)', () => {
    function listed(res: Awaited<ReturnType<typeof listDetections>>): Detection[] {
      return res.json<{ items: Detection[] }>().items;
    }

    it('lists the detections of a capture ordered by observation time', async () => {
      const captureId = await createCapture();
      await postDetection(captureId, { label: 'later', observedAt: '2026-03-01T12:00:00Z' });
      await postDetection(captureId, {
        label: 'earlier',
        observedAt: '2026-03-01T09:00:00Z',
        location: { type: 'Point', coordinates: [13.41, 52.51] },
      });

      const res = await listDetections(captureId);

      expect(res.statusCode).toBe(200);
      expect(listed(res)).toMatchObject([
        {
          label: 'earlier',
          detectorId: 'manual',
          confidence: null,
          bbox: BBOX,
          location: { type: 'Point', coordinates: [13.41, 52.51] },
          observedAt: '2026-03-01T09:00:00.000Z',
          attributes: {},
        },
        // No own location: the capture's is the effective one.
        { label: 'later', location: { type: 'Point', coordinates: [13.4, 52.5] } },
      ]);
    });

    it('lists detections on both sides of a month boundary', async () => {
      const captureId = await createCapture();
      await postDetection(captureId, { label: 'february', observedAt: '2026-02-01T00:00:00Z' });
      await postDetection(captureId, { label: 'january', observedAt: '2026-01-31T23:59:59Z' });

      const items = listed(await listDetections(captureId));

      expect(items.map((item) => [item.label, item.observedAt])).toEqual([
        ['january', '2026-01-31T23:59:59.000Z'],
        ['february', '2026-02-01T00:00:00.000Z'],
      ]);
    });

    it('stores and lists an observation from three years ago like any other', async () => {
      const captureId = await createCapture();
      const old = new Date();
      old.setUTCFullYear(old.getUTCFullYear() - 3);

      const created = await postDetection(captureId, { observedAt: old.toISOString() });
      const items = listed(await listDetections(captureId));

      expect(created.statusCode).toBe(201);
      expect(items).toEqual([created.json()]);
      // Older than the pre-created monthly partitions, so it lands in the DEFAULT partition.
      const { rows } = await ctx.infra.pool.query<{ partition: string }>(
        'SELECT tableoid::regclass::text AS partition FROM detection WHERE id = $1',
        [created.json<Detection>().id],
      );
      expect(rows).toEqual([{ partition: 'detection_default' }]);
    });

    it('returns an empty list for a capture without detections', async () => {
      const captureId = await createCapture();

      const res = await listDetections(captureId);

      expect(res.statusCode).toBe(200);
      expect(listed(res)).toEqual([]);
    });

    it('returns 404 for an unknown capture', async () => {
      const res = await listDetections(randomUUID());

      expect(res.statusCode).toBe(404);
      expect(res.json<ErrorBody>().error.code).toBe('not_found');
    });

    it('keeps detections of other captures out of the list', async () => {
      const first = await createCapture();
      const second = await createCapture();
      await postDetection(first, { label: 'mine' });
      await postDetection(second, { label: 'theirs' });

      const items = listed(await listDetections(first));

      expect(items.map((item) => item.label)).toEqual(['mine']);
    });
  });
});
