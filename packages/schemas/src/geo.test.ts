import { describe, expect, it } from 'vitest';
import {
  geoBoundingBoxSchema,
  crossesAntimeridian,
  detectionFilterSchema,
  nearSchema,
  pageSizeSchema,
} from './geo.js';

/** Paths of the fields that failed validation, e.g. `south`. */
function failedPaths(
  schema: {
    safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[] }[] } };
  },
  input: unknown,
): string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

const BERLIN_BOX = { west: 13.0, south: 52.3, east: 13.8, north: 52.7 };
const CENTER = { type: 'Point', coordinates: [13.4, 52.5] };

describe('bounding box', () => {
  it('accepts a regular box', () => {
    expect(geoBoundingBoxSchema.parse(BERLIN_BOX)).toEqual(BERLIN_BOX);
    expect(crossesAntimeridian(BERLIN_BOX)).toBe(false);
  });

  it('accepts a box across the antimeridian (west > east)', () => {
    const box = { west: 170, south: -20, east: -170, north: 20 };

    expect(geoBoundingBoxSchema.parse(box)).toEqual(box);
    expect(crossesAntimeridian(box)).toBe(true);
  });

  it('accepts the whole world and a degenerate box (south = north)', () => {
    expect(
      failedPaths(geoBoundingBoxSchema, { west: -180, south: -90, east: 180, north: 90 }),
    ).toEqual([]);
    expect(failedPaths(geoBoundingBoxSchema, { west: 13, south: 52, east: 14, north: 52 })).toEqual(
      [],
    );
  });

  it.each([
    ['inverted latitudes', { ...BERLIN_BOX, south: 53, north: 52 }, ['south']],
    ['a longitude above 180', { ...BERLIN_BOX, east: 181 }, ['east']],
    ['a longitude below -180', { ...BERLIN_BOX, west: -180.5 }, ['west']],
    ['a latitude above 90', { ...BERLIN_BOX, north: 91 }, ['north']],
    ['a latitude below -90', { ...BERLIN_BOX, south: -91 }, ['south']],
    ['a missing edge', { west: 13, south: 52, east: 14 }, ['north']],
  ])('rejects %s', (_, input, paths) => {
    expect(failedPaths(geoBoundingBoxSchema, input)).toEqual(paths);
  });
});

describe('near (radius search)', () => {
  it.each([1, 1000, 50_000])('accepts a radius of %d m', (radiusMeters) => {
    expect(failedPaths(nearSchema, { center: CENTER, radiusMeters })).toEqual([]);
  });

  it.each([
    ['a radius above 50 km', { center: CENTER, radiusMeters: 60_000 }, ['radiusMeters']],
    ['a zero radius', { center: CENTER, radiusMeters: 0 }, ['radiusMeters']],
    ['a negative radius', { center: CENTER, radiusMeters: -5 }, ['radiusMeters']],
    [
      'a center out of range',
      { center: { type: 'Point', coordinates: [13.4, 95] }, radiusMeters: 100 },
      ['center.coordinates.1'],
    ],
  ])('rejects %s', (_, input, paths) => {
    expect(failedPaths(nearSchema, input)).toEqual(paths);
  });
});

describe('detection filter', () => {
  it('accepts no filter, a box, a radius and a detector', () => {
    expect(failedPaths(detectionFilterSchema, {})).toEqual([]);
    expect(failedPaths(detectionFilterSchema, { bbox: BERLIN_BOX, detectorId: 'manual' })).toEqual(
      [],
    );
    expect(
      failedPaths(detectionFilterSchema, { near: { center: CENTER, radiusMeters: 500 } }),
    ).toEqual([]);
  });

  it('rejects a box and a radius together', () => {
    expect(
      failedPaths(detectionFilterSchema, {
        bbox: BERLIN_BOX,
        near: { center: CENTER, radiusMeters: 500 },
      }),
    ).toEqual(['near']);
  });

  it('names nested paths', () => {
    expect(
      failedPaths(detectionFilterSchema, { bbox: { ...BERLIN_BOX, south: 53, north: 52 } }),
    ).toEqual(['bbox.south']);
  });
});

describe('page size', () => {
  it('defaults to 50 and accepts 1-100', () => {
    expect(pageSizeSchema.parse(undefined)).toBe(50);
    expect(pageSizeSchema.parse(1)).toBe(1);
    expect(pageSizeSchema.parse(100)).toBe(100);
  });

  it.each([0, 101, 2.5])('rejects %d', (first) => {
    expect(failedPaths(pageSizeSchema, first)).toEqual(['']);
  });
});
