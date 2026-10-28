import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, type Fetch } from './api.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records each call and answers from `responses` in order. */
function fakeFetch(responses: Response[]): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    const next = responses.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected request'));
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ApiClient.uploadCapture', () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });

  it('creates the capture, PUTs the bytes to the presigned URL, then completes it', async () => {
    const { fetch, calls } = fakeFetch([
      json(201, {
        id: 'c1',
        uploadUrl: 'http://storage.test/captures/images/c1?sig',
        uploadHeaders: { 'content-type': 'image/png' },
      }),
      new Response(null, { status: 200 }),
      json(200, { id: 'c1', status: 'ready' }),
    ]);

    const capture = await new ApiClient(fetch).uploadCapture(file, {
      type: 'Point',
      coordinates: [13.4, 52.5],
    });

    expect(capture).toEqual({ id: 'c1', status: 'ready' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/captures',
      'PUT http://storage.test/captures/images/c1?sig',
      'POST /api/captures/c1/complete',
    ]);
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      contentType: 'image/png',
      byteSize: 3,
      location: { type: 'Point', coordinates: [13.4, 52.5] },
    });
    expect(calls[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]?.headers).toEqual({ 'content-type': 'image/png' });
    expect(calls[1]?.body).toBe(file);
  });

  it('stops before completing when storage rejects the upload', async () => {
    const { fetch, calls } = fakeFetch([
      json(201, { id: 'c1', uploadUrl: 'http://storage.test/x', uploadHeaders: {} }),
      new Response(null, { status: 403 }),
    ]);

    await expect(new ApiClient(fetch).uploadCapture(file)).rejects.toMatchObject({
      status: 403,
      code: 'upload_failed',
    });
    expect(calls).toHaveLength(2);
  });
});

describe('ApiClient errors', () => {
  it('maps the error body, including field issues', async () => {
    const { fetch } = fakeFetch([
      json(400, {
        error: {
          code: 'invalid_request',
          message: 'Invalid bbox.w',
          issues: [{ path: 'bbox.w', message: 'Too small' }],
        },
      }),
    ]);

    const error: unknown = await new ApiClient(fetch)
      .createDetection('c1', {
        detectorId: 'manual',
        label: 'x',
        bbox: { x: 0, y: 0, w: -5, h: 1 },
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'invalid_request',
      issues: [{ path: 'bbox.w', message: 'Too small' }],
    });
  });

  it('reads the health report even when the API answers 503', async () => {
    const { fetch } = fakeFetch([json(503, { status: 'error', database: 'error' })]);

    expect(await new ApiClient(fetch).health()).toEqual({ status: 'error', database: 'error' });
  });
});
