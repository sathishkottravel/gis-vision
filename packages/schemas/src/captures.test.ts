import { describe, expect, it } from 'vitest';
import { createCaptureRequestSchema, listCapturesQuerySchema } from './captures.js';

const schema = createCaptureRequestSchema({ maxBytes: 1000 });

/** Paths of the fields that failed validation, e.g. `location.coordinates.1`. */
function failedPaths(input: unknown): string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('capture request schema', () => {
  it('accepts metadata with capture time and location', () => {
    const input = {
      contentType: 'image/jpeg',
      byteSize: 1000,
      capturedAt: '2026-03-01T10:00:00+01:00',
      location: { type: 'Point', coordinates: [13.4, 52.5] },
    };

    expect(schema.parse(input)).toEqual(input);
  });

  it('accepts only content type and byte size', () => {
    expect(schema.parse({ contentType: 'image/webp', byteSize: 1 })).toEqual({
      contentType: 'image/webp',
      byteSize: 1,
    });
  });

  it.each(['image/jpeg', 'image/png', 'image/webp'])('allows %s', (contentType) => {
    expect(failedPaths({ contentType, byteSize: 1 })).toEqual([]);
  });

  it.each(['application/pdf', 'image/gif', ''])('rejects content type %j', (contentType) => {
    expect(failedPaths({ contentType, byteSize: 1 })).toEqual(['contentType']);
  });

  it.each([
    ['above the configured maximum', 1001],
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1.5],
  ])('rejects a byte size %s', (_, byteSize) => {
    expect(failedPaths({ contentType: 'image/png', byteSize })).toEqual(['byteSize']);
  });

  it.each([
    ['latitude 95', [13.4, 95], 'location.coordinates.1'],
    ['latitude -91', [13.4, -91], 'location.coordinates.1'],
    ['longitude 181', [181, 52.5], 'location.coordinates.0'],
  ])('rejects a point with %s', (_, coordinates, path) => {
    const location = { type: 'Point', coordinates };

    expect(failedPaths({ contentType: 'image/png', byteSize: 1, location })).toEqual([path]);
  });

  it('rejects a location that is not a GeoJSON Point', () => {
    const location = { type: 'LineString', coordinates: [13.4, 52.5] };

    expect(failedPaths({ contentType: 'image/png', byteSize: 1, location })).toEqual([
      'location.type',
    ]);
  });

  it('rejects a capture time without a timezone offset', () => {
    expect(
      failedPaths({ contentType: 'image/png', byteSize: 1, capturedAt: '2026-03-01 10:00' }),
    ).toEqual(['capturedAt']);
  });

  it('reports every missing required field', () => {
    expect(failedPaths({})).toEqual(['contentType', 'byteSize']);
  });
});

describe('list captures query schema', () => {
  it('defaults the page size', () => {
    expect(listCapturesQuerySchema.parse({})).toEqual({ limit: 20 });
  });

  it('coerces a query-string limit', () => {
    expect(listCapturesQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 });
  });

  it.each(['0', '101', 'abc'])('rejects limit %j', (limit) => {
    expect(listCapturesQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});
