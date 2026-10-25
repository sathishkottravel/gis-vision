import { describe, expect, it } from 'vitest';
import { parseEwkbPoint } from './geometry.js';

describe('parseEwkbPoint', () => {
  it('decodes a little-endian EWKB point with SRID (what PostGIS returns)', () => {
    // SELECT ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326)
    expect(parseEwkbPoint('0101000020E6100000CDCCCCCCCCCC2A400000000000404A40')).toEqual({
      x: 13.4,
      y: 52.5,
    });
  });

  it('decodes a big-endian WKB point without SRID', () => {
    // SELECT ST_AsBinary(ST_MakePoint(-1.5, 2), 'XDR')
    expect(parseEwkbPoint('0000000001BFF80000000000004000000000000000')).toEqual({ x: -1.5, y: 2 });
  });

  it('rejects geometries that are not 2D points', () => {
    // SELECT ST_SetSRID(ST_MakeLine(ST_MakePoint(0, 0), ST_MakePoint(1, 1)), 4326)
    expect(() =>
      parseEwkbPoint(
        '0102000020E61000000200000000000000000000000000000000000000000000000000F03F000000000000F03F',
      ),
    ).toThrow('expected a 2D point');
  });
});
