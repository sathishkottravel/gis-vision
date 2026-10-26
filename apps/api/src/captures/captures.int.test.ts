import { randomUUID } from 'node:crypto';
import type { Capture, CreateCaptureResponse } from '@gis-vision/schemas';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capture } from '../db/schema.js';
import type { ErrorBody } from '../http/error-handler.js';
import { buildIntegrationApp, type IntegrationApp } from '../testing/integration-app.js';

describe('capture upload REST API', () => {
  let ctx: IntegrationApp;
  const created: string[] = [];

  beforeAll(async () => {
    ctx = await buildIntegrationApp();
  });

  afterAll(async () => {
    const { db, blobStore } = ctx.infra;
    if (created.length > 0) {
      const rows = await db.delete(capture).where(inArray(capture.id, created)).returning();
      await Promise.all(rows.map((row) => blobStore.delete(row.blobKey)));
    }
    await ctx.app.close();
  });

  async function postCapture(body: unknown, headers: Record<string, string> = {}) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/captures',
      payload: body as object,
      headers,
    });
    if (res.statusCode === 201) {
      created.push(res.json<CreateCaptureResponse>().id);
    }
    return res;
  }

  function issuePaths(body: ErrorBody): string[] {
    return body.error.issues?.map((issue) => issue.path) ?? [];
  }

  /** A tiny stand-in image: the API checks size and type, not pixels. */
  const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  async function createPending(byteSize = IMAGE.byteLength): Promise<CreateCaptureResponse> {
    const res = await postCapture({ contentType: 'image/png', byteSize });
    return res.json<CreateCaptureResponse>();
  }

  /** Uploads straight to RustFS through the presigned URL, as a browser would. */
  async function upload(pending: CreateCaptureResponse, bytes = IMAGE): Promise<Response> {
    return fetch(pending.uploadUrl, { method: 'PUT', headers: pending.uploadHeaders, body: bytes });
  }

  async function complete(id: string) {
    return ctx.app.inject({ method: 'POST', url: `/captures/${id}/complete` });
  }

  async function storedStatus(id: string): Promise<string | undefined> {
    const [row] = await ctx.infra.db.select().from(capture).where(eq(capture.id, id));
    return row?.status;
  }

  describe('POST /captures (F1.4 10.2)', () => {
    it('creates a pending capture with a presigned upload URL', async () => {
      const before = Date.now();
      const res = await postCapture({
        contentType: 'image/jpeg',
        byteSize: 2048,
        capturedAt: '2026-03-01T10:00:00+01:00',
        location: { type: 'Point', coordinates: [13.4, 52.5] },
      });
      const body = res.json<CreateCaptureResponse>();

      expect(res.statusCode).toBe(201);
      expect(body).toMatchObject({
        status: 'pending',
        contentType: 'image/jpeg',
        byteSize: 2048,
        capturedAt: '2026-03-01T09:00:00.000Z',
        location: { type: 'Point', coordinates: [13.4, 52.5] },
        uploadHeaders: { 'content-type': 'image/jpeg' },
      });
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.uploadUrl).toContain(body.id);
      expect(body).not.toHaveProperty('imageUrl');
      const ttlMs = ctx.config.UPLOAD_URL_TTL_SECONDS * 1000;
      expect(Date.parse(body.expiresAt)).toBeGreaterThanOrEqual(before + ttlMs - 1000);
      expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(Date.now() + ttlMs);
    });

    it('defaults the capture time to the creation time and stores no location', async () => {
      const res = await postCapture({ contentType: 'image/png', byteSize: 1 });
      const body = res.json<CreateCaptureResponse>();

      expect(res.statusCode).toBe(201);
      expect(body.location).toBeNull();
      expect(body.capturedAt).toBe(body.createdAt);
    });

    it.each([
      [
        'an unsupported content type',
        { contentType: 'application/pdf', byteSize: 1 },
        'contentType',
      ],
      ['a non-positive size', { contentType: 'image/png', byteSize: 0 }, 'byteSize'],
      [
        'coordinates out of range',
        {
          contentType: 'image/png',
          byteSize: 1,
          location: { type: 'Point', coordinates: [13.4, 95] },
        },
        'location.coordinates.1',
      ],
    ])('rejects %s with 400 naming the field', async (_, body, field) => {
      const res = await postCapture(body);

      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe('invalid_request');
      expect(issuePaths(res.json())).toEqual([field]);
    });

    it('rejects a file above the configured maximum with 400', async () => {
      const res = await postCapture({
        contentType: 'image/jpeg',
        byteSize: ctx.config.UPLOAD_MAX_BYTES + 1,
      });

      expect(res.statusCode).toBe(400);
      expect(issuePaths(res.json())).toEqual(['byteSize']);
    });

    it('rejects a malformed JSON body with 400', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/captures',
        headers: { 'content-type': 'application/json' },
        payload: '{"contentType":',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe('invalid_request');
    });

    it('returns the original capture when a request is retried with the same Idempotency-Key', async () => {
      const key = `retry-${randomUUID()}`;
      const body = { contentType: 'image/webp', byteSize: 512 };

      const first = await postCapture(body, { 'idempotency-key': key });
      const second = await postCapture(body, { 'idempotency-key': key });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json<Capture>().id).toBe(first.json<Capture>().id);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(second.headers['idempotent-replayed']).toBe('true');
      const rows = await ctx.infra.db.select().from(capture).where(eq(capture.idempotencyKey, key));
      expect(rows).toHaveLength(1);
    });

    it('rejects an Idempotency-Key reused with a different payload with 409', async () => {
      const key = `reuse-${randomUUID()}`;
      await postCapture({ contentType: 'image/webp', byteSize: 512 }, { 'idempotency-key': key });

      const res = await postCapture(
        { contentType: 'image/webp', byteSize: 513 },
        { 'idempotency-key': key },
      );

      expect(res.statusCode).toBe(409);
      expect(res.json<ErrorBody>().error.code).toBe('idempotency_key_reused');
    });

    it('rejects a malformed Idempotency-Key with 400', async () => {
      const res = await postCapture(
        { contentType: 'image/png', byteSize: 1 },
        { 'idempotency-key': 'x'.repeat(256) },
      );

      expect(res.statusCode).toBe(400);
      expect(issuePaths(res.json())).toEqual(['idempotency-key']);
    });
  });

  describe('POST /captures/:id/complete (F1.4 10.3)', () => {
    it('marks the capture ready after the image was uploaded', async () => {
      const pending = await createPending();
      expect((await upload(pending)).ok).toBe(true);

      const res = await complete(pending.id);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: pending.id, status: 'ready' });
      expect(await storedStatus(pending.id)).toBe('ready');
    });

    it('returns 409 and keeps the capture pending when nothing was uploaded', async () => {
      const pending = await createPending();

      const res = await complete(pending.id);

      expect(res.statusCode).toBe(409);
      expect(res.json<ErrorBody>().error.code).toBe('upload_missing');
      expect(await storedStatus(pending.id)).toBe('pending');
    });

    it('returns 409 and keeps the capture pending when the size differs', async () => {
      const pending = await createPending(IMAGE.byteLength + 1);
      expect((await upload(pending)).ok).toBe(true);

      const res = await complete(pending.id);

      expect(res.statusCode).toBe(409);
      expect(res.json<ErrorBody>().error.code).toBe('upload_size_mismatch');
      expect(await storedStatus(pending.id)).toBe('pending');
    });

    it('is idempotent: completing a ready capture again changes nothing', async () => {
      const pending = await createPending();
      await upload(pending);
      const first = await complete(pending.id);

      const second = await complete(pending.id);

      expect(second.statusCode).toBe(200);
      // Only the freshly signed imageUrl may differ between the two responses.
      const withoutUrl = (body: Capture) => ({ ...body, imageUrl: undefined });
      expect(withoutUrl(second.json())).toEqual(withoutUrl(first.json()));
      expect(second.json<Capture>().status).toBe('ready');
    });

    it.each([
      ['an unknown id', randomUUID()],
      ['an id that is not a UUID', 'not-a-uuid'],
    ])('returns 404 for %s', async (_, id) => {
      const res = await complete(id);

      expect(res.statusCode).toBe(404);
      expect(res.json<ErrorBody>().error.code).toBe('not_found');
    });
  });

  describe('GET /captures/:id and GET /captures (F1.4 10.4)', () => {
    async function getCapture(id: string) {
      return ctx.app.inject({ method: 'GET', url: `/captures/${id}` });
    }

    it('returns a ready capture with an imageUrl that downloads the image', async () => {
      const res = await postCapture({
        contentType: 'image/png',
        byteSize: IMAGE.byteLength,
        location: { type: 'Point', coordinates: [-73.98, 40.75] },
      });
      const pending = res.json<CreateCaptureResponse>();
      await upload(pending);
      await complete(pending.id);

      const got = await getCapture(pending.id);
      const body = got.json<Capture>();

      expect(got.statusCode).toBe(200);
      expect(body).toMatchObject({
        id: pending.id,
        status: 'ready',
        contentType: 'image/png',
        byteSize: IMAGE.byteLength,
        location: { type: 'Point', coordinates: [-73.98, 40.75] },
      });
      const image = await fetch(body.imageUrl ?? '');
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/png');
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(IMAGE);
    });

    it('returns a pending capture without an imageUrl', async () => {
      const pending = await createPending();

      const got = await getCapture(pending.id);

      expect(got.statusCode).toBe(200);
      expect(got.json()).toMatchObject({ id: pending.id, status: 'pending', location: null });
      expect(got.json()).not.toHaveProperty('imageUrl');
    });

    it('returns 404 for an unknown capture', async () => {
      const got = await getCapture(randomUUID());

      expect(got.statusCode).toBe(404);
      expect(got.json<ErrorBody>().error.code).toBe('not_found');
    });

    it('lists captures newest first', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push((await createPending()).id);
      }

      const res = await ctx.app.inject({ method: 'GET', url: '/captures?limit=100' });
      const listed = res
        .json<{ items: Capture[] }>()
        .items.map((item) => item.id)
        .filter((id) => ids.includes(id));

      expect(res.statusCode).toBe(200);
      expect(listed).toEqual([...ids].reverse());
    });

    it('bounds the page size', async () => {
      await createPending();
      await createPending();

      const page = await ctx.app.inject({ method: 'GET', url: '/captures?limit=1' });
      const tooLarge = await ctx.app.inject({ method: 'GET', url: '/captures?limit=101' });

      expect(page.json<{ items: Capture[] }>().items).toHaveLength(1);
      expect(tooLarge.statusCode).toBe(400);
      expect(issuePaths(tooLarge.json())).toEqual(['limit']);
    });
  });
});
