import { describe, expect, it } from 'vitest';
import { normalizeBounds } from './map-bounds.js';

describe('normalizeBounds', () => {
  it('passes an ordinary view through', () => {
    expect(normalizeBounds({ west: 13.2, south: 52.4, east: 13.6, north: 52.6 })).toEqual({
      west: 13.2,
      south: 52.4,
      east: 13.6,
      north: 52.6,
    });
  });

  it('wraps a view across the antimeridian into a west > east box', () => {
    expect(normalizeBounds({ west: 170, south: -20, east: 190, north: -10 })).toEqual({
      west: 170,
      south: -20,
      east: -170,
      north: -10,
    });
    expect(normalizeBounds({ west: -190, south: -20, east: -170, north: -10 })).toMatchObject({
      west: 170,
      east: -170,
    });
  });

  it('wraps a view panned onto another copy of the world', () => {
    expect(normalizeBounds({ west: 373.2, south: 52.4, east: 373.6, north: 52.6 })).toMatchObject({
      west: expect.closeTo(13.2, 9) as number,
      east: expect.closeTo(13.6, 9) as number,
    });
  });

  it('keeps east = 180 for a view ending on the antimeridian', () => {
    expect(normalizeBounds({ west: 170, south: 0, east: 180, north: 10 })).toMatchObject({
      west: 170,
      east: 180,
    });
  });

  it('sends no box for a view spanning the whole world', () => {
    expect(normalizeBounds({ west: -180, south: -85, east: 180, north: 85 })).toBeUndefined();
    expect(normalizeBounds({ west: -400, south: -85, east: 300, north: 85 })).toBeUndefined();
  });

  it('clamps latitudes to ±90', () => {
    expect(normalizeBounds({ west: 0, south: -95, east: 10, north: 95 })).toMatchObject({
      south: -90,
      north: 90,
    });
  });
});
